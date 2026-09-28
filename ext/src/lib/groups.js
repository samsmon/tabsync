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
