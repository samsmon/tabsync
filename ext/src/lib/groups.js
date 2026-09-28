import { db } from './db.js';

// Monotonic clock so two edits in the same ms still order correctly.
let last = 0;
const now = () => (last = Math.max(Date.now(), last + 1));

async function write(g) {
  await db.put({ ...g, ts: now(), dirty: true });
  chrome.runtime.sendMessage({ type: 'changed', local: true }).catch(() => {});
}

export async function createGroup(tabs) {
  const id = crypto.randomUUID();
  await write({
    id,
    deleted: false,
    data: { title: '', createdAt: Date.now(), locked: false, starred: false, tabs },
  });
  return id;
}

// Bulk import keeps the source order: first group is treated as newest.
export async function importGroups(tabLists) {
  const base = Date.now();
  for (let i = 0; i < tabLists.length; i++) {
    await db.put({
      id: crypto.randomUUID(),
      ts: now(),
      dirty: true,
      deleted: false,
      data: { title: '', createdAt: base - i, locked: false, starred: false, tabs: tabLists[i] },
    });
  }
  chrome.runtime.sendMessage({ type: 'changed', local: true }).catch(() => {});
}

export async function updateGroup(id, patch) {
  const g = await db.get(id);
  if (!g || g.deleted) return;
  const data = { ...g.data, ...patch };
  if (data.tabs.length === 0) return deleteGroup(id);
  await write({ ...g, data });
}

export async function deleteGroup(id) {
  const g = await db.get(id);
  if (g) await write({ ...g, deleted: true, data: null });
}

export async function listGroups() {
  return (await db.all())
    .filter((g) => !g.deleted)
    .sort((a, b) => (b.data.starred - a.data.starred) || (b.data.createdAt - a.data.createdAt));
}
