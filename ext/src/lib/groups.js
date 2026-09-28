// Every tab and every group's meta is its own record, so edits from different
// devices only conflict when they touch the very same tab (last writer wins).
import { db } from './db.js';

// Monotonic clock so two edits in the same ms still order correctly.
let last = 0;
const now = () => (last = Math.max(Date.now(), last + 1));

const rec = (id, data) => ({ id, ts: now(), dirty: true, deleted: false, data });
const tomb = (id) => ({ id, ts: now(), dirty: true, deleted: true, data: null });
const live = (r) => !r.deleted;

// runtime.sendMessage never reaches the sender's own page, so same-context listeners are
// notified directly; other pages (and the list, for edits made by the worker) get the message.
const listeners = new Set();
export function onChanged(fn) {
  const onMsg = (m) => m?.type === 'changed' && fn();
  listeners.add(fn);
  chrome.runtime.onMessage.addListener(onMsg);
  return () => { listeners.delete(fn); chrome.runtime.onMessage.removeListener(onMsg); };
}

function changed() {
  for (const fn of listeners) fn();
  chrome.runtime.sendMessage({ type: 'changed', local: true }).catch(() => {});
}

function groupRecords(gid, meta, tabs, idFor = () => crypto.randomUUID()) {
  return [
    rec(gid, meta),
    ...tabs.map((t, i) => rec(`t:${idFor(i)}`, { groupId: gid, url: t.url, title: t.title, pos: i })),
  ];
}

const newMeta = (createdAt = Date.now()) => ({ title: '', createdAt, locked: false, starred: false, pinned: false });

// URLs already in the list are dropped silently, so the stored copy (and its title) wins.
// `meta` adds to the defaults, e.g. { title, device, chromeGroup: { color } }.
export async function createGroup(tabs, meta = {}) {
  const seen = new Set();
  const fresh = [];
  for (const t of tabs) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    if (!(await db.byIndex('url', t.url)).some(live)) fresh.push(t);
  }
  tabs = fresh;
  if (!tabs.length) return null;
  const gid = `g:${crypto.randomUUID()}`;
  await db.putMany(groupRecords(gid, { ...newMeta(), ...meta }, tabs));
  changed();
  return gid;
}

// Quick archive: one fixed group (same id on every device, so it merges through sync) for
// links worth keeping. Opening a link from it never removes it.
export const ARCHIVE = 'g:archive';

// Returns the archive meta record to write when it doesn't exist (or was emptied).
async function archiveMeta() {
  const g = await db.get(ARCHIVE);
  return g && !g.deleted ? [] : [rec(ARCHIVE, { ...newMeta(), title: 'Quick archive', archive: true, locked: true })];
}

// Appends to the archive; URLs already in the archive are skipped. Returns how many were added.
export async function addToArchive(tabs) {
  const existing = (await tabsOf(ARCHIVE));
  const seen = new Set(existing.map((r) => r.data.url));
  let pos = Math.max(-1, ...existing.map((r) => r.data.pos));
  const out = [];
  for (const t of tabs) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    out.push(rec(`t:${crypto.randomUUID()}`, { groupId: ARCHIVE, url: t.url, title: t.title, pos: ++pos }));
  }
  if (!out.length) return 0;
  await db.putMany([...(await archiveMeta()), ...out]);
  changed();
  return out.length;
}

// Bulk import keeps the source order: first group is treated as newest.
export async function importGroups(tabLists, meta = {}) {
  const base = Date.now();
  await db.putMany(
    tabLists.flatMap((tabs, i) => groupRecords(`g:${crypto.randomUUID()}`, { ...newMeta(base - i), ...meta }, tabs)),
  );
  changed();
}

export async function updateGroup(gid, patch) {
  const g = await db.get(gid);
  if (!g || g.deleted) return;
  await db.put(rec(gid, { ...g.data, ...patch }));
  changed();
}

const tabsOf = async (gid) => (await db.byIndex('groupId', gid)).filter(live);
const byPos = (a, b) => a.data.pos - b.data.pos || (a.id < b.id ? -1 : 1);

// removeTab/deleteGroup return a snapshot of what they tombstoned; pass it to undo().
export async function removeTab(tabId) {
  const t = await db.get(tabId);
  if (!t || t.deleted) return [];
  const before = [t];
  if (!(await tabsOf(t.data.groupId)).some((r) => r.id !== tabId)) before.push(await db.get(t.data.groupId));
  await db.putMany(before.filter(Boolean).map((r) => tomb(r.id)));
  changed();
  return before.filter(Boolean);
}

export async function deleteGroup(gid) {
  const g = await db.get(gid);
  if (!g || g.deleted) return [];
  const before = [g, ...(await tabsOf(gid))];
  await db.putMany(before.map((r) => tomb(r.id)));
  changed();
  return before;
}

// Resurrects a snapshot with fresh timestamps so the undo also wins on other devices.
export async function undo(snapshot) {
  if (!snapshot?.length) return;
  await db.putMany(snapshot.map((r) => rec(r.id, r.data)));
  changed();
}

// Moves a tab into group `gid`, before tab `beforeId` (or to the end). Positions are
// fractional, so only the moved tab's record changes.
export async function moveTab(tabId, gid, beforeId = null) {
  const t = await db.get(tabId);
  if (!t || t.deleted || tabId === beforeId) return;
  const siblings = (await tabsOf(gid)).filter((r) => r.id !== tabId).sort(byPos);
  let i = siblings.findIndex((r) => r.id === beforeId);
  if (i < 0) i = siblings.length;
  const prev = siblings[i - 1]?.data.pos;
  const next = siblings[i]?.data.pos;
  const pos = prev == null ? (next == null ? 0 : next - 1) : next == null ? prev + 1 : (prev + next) / 2;
  const out = [rec(tabId, { ...t.data, groupId: gid, pos }), ...(gid === ARCHIVE ? await archiveMeta() : [])];
  const from = t.data.groupId;
  if (from !== gid && !(await tabsOf(from)).some((r) => r.id !== tabId)) out.push(tomb(from));
  await db.putMany(out);
  changed();
}

// Returns [{ id, data: { ...meta, tabs: [{ id, url, title }] } }]
// A deleted group hides its tabs, even ones added concurrently on another device.
export async function listGroups() {
  const metas = new Map();
  const tabs = new Map();
  for (const r of await db.all()) {
    if (r.deleted) continue;
    if (r.id.startsWith('g:')) metas.set(r.id, r.data);
    else if (r.id.startsWith('t:')) {
      const list = tabs.get(r.data.groupId) ?? [];
      list.push({ id: r.id, ...r.data });
      tabs.set(r.data.groupId, list);
    }
  }
  const out = [];
  for (const [id, meta] of metas) {
    const list = tabs.get(id);
    if (!list?.length) continue;
    list.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
    out.push({ id, data: { ...meta, tabs: list } });
  }
  // pinned first, then starred, then newest; older records have no `pinned` field (treated as false)
  return out.sort((a, b) => (!!b.data.pinned - !!a.data.pinned) || (b.data.starred - a.data.starred) || (b.data.createdAt - a.data.createdAt));
}

// Split v1 whole-group records into per-tab records. IDs are derived from the
// legacy id, so two devices migrating the same group produce identical records.
export async function migrateLegacy() {
  const legacy = (await db.all()).filter((r) => !r.id.includes(':') && !r.deleted && r.data?.tabs);
  if (!legacy.length) return 0;
  const out = [];
  for (const r of legacy) {
    const { tabs, ...meta } = r.data;
    out.push(...groupRecords(`g:${r.id}`, meta, tabs, (i) => `${r.id}-${i}`), tomb(r.id));
  }
  await db.putMany(out);
  changed();
  return legacy.length;
}
