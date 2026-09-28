// Every tab and every group's meta is its own record, so edits from different
// devices only conflict when they touch the very same tab (last writer wins).
import { db } from './db.js';

// Monotonic clock so two edits in the same ms still order correctly.
let last = 0;
const now = () => (last = Math.max(Date.now(), last + 1));

const rec = (id, data) => ({ id, ts: now(), dirty: true, deleted: false, data });
const tomb = (id) => ({ id, ts: now(), dirty: true, deleted: true, data: null });

function changed() {
  chrome.runtime.sendMessage({ type: 'changed', local: true }).catch(() => {});
}

function groupRecords(gid, meta, tabs, idFor = () => crypto.randomUUID()) {
  return [
    rec(gid, meta),
    ...tabs.map((t, i) => rec(`t:${idFor(i)}`, { groupId: gid, url: t.url, title: t.title, pos: i })),
  ];
}

const newMeta = (createdAt = Date.now()) => ({ title: '', createdAt, locked: false, starred: false });

// URLs already in the list are dropped silently, so the stored copy (and its title) wins.
export async function createGroup(tabs) {
  const seen = new Set((await db.all()).filter((r) => !r.deleted && r.id.startsWith('t:')).map((r) => r.data.url));
  tabs = tabs.filter((t) => !seen.has(t.url) && seen.add(t.url));
  if (!tabs.length) return null;
  const gid = `g:${crypto.randomUUID()}`;
  await db.putMany(groupRecords(gid, newMeta(), tabs));
  changed();
  return gid;
}

// Bulk import keeps the source order: first group is treated as newest.
export async function importGroups(tabLists) {
  const base = Date.now();
  await db.putMany(
    tabLists.flatMap((tabs, i) => groupRecords(`g:${crypto.randomUUID()}`, newMeta(base - i), tabs)),
  );
  changed();
}

export async function updateGroup(gid, patch) {
  const g = await db.get(gid);
  if (!g || g.deleted) return;
  await db.put(rec(gid, { ...g.data, ...patch }));
  changed();
}

export async function removeTab(tabId) {
  const t = await db.get(tabId);
  if (!t || t.deleted) return;
  const out = [tomb(tabId)];
  const siblings = (await db.all()).filter((r) => !r.deleted && r.id !== tabId && r.data?.groupId === t.data.groupId);
  if (!siblings.length) out.push(tomb(t.data.groupId));
  await db.putMany(out);
  changed();
}

export async function deleteGroup(gid) {
  const tabs = (await db.all()).filter((r) => !r.deleted && r.data?.groupId === gid);
  await db.putMany([tomb(gid), ...tabs.map((t) => tomb(t.id))]);
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
  return out.sort((a, b) => (b.data.starred - a.data.starred) || (b.data.createdAt - a.data.createdAt));
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
