// Run: node test/groups.test.mjs
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() } };

// seed a v1 database the way the old extension wrote it
await new Promise((res) => {
  const r = indexedDB.open('tabsync', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('groups', { keyPath: 'id' });
    r.result.createObjectStore('kv');
  };
  r.onsuccess = () => {
    const tx = r.result.transaction('groups', 'readwrite');
    tx.objectStore('groups').put({
      id: 'legacy1', ts: 1, deleted: false, dirty: false,
      data: { title: 'old', createdAt: 5, locked: true, starred: false, tabs: [{ url: 'https://a', title: 'A' }, { url: 'https://b', title: 'B' }] },
    });
    tx.oncomplete = () => { r.result.close(); res(); };
  };
});

const { db } = await import('../src/lib/db.js');
const G = await import('../src/lib/groups.js');

// v1 -> v2 upgrade keeps data, migration splits it with deterministic ids
assert.equal((await db.get('legacy1')).data.title, 'old');
assert.equal(await G.migrateLegacy(), 1);
assert.equal(await G.migrateLegacy(), 0, 'idempotent');
assert.ok((await db.get('legacy1')).deleted);
let groups = await G.listGroups();
assert.equal(groups.length, 1);
assert.equal(groups[0].id, 'g:legacy1');
assert.deepEqual(groups[0].data.tabs.map((t) => t.id), ['t:legacy1-0', 't:legacy1-1']);
assert.equal(groups[0].data.locked, true);

// create + remove a single tab only touches that tab's record
const gid = await G.createGroup([{ url: 'https://x', title: 'X' }, { url: 'https://y', title: 'Y' }]);
groups = await G.listGroups();
const [x, y] = groups.find((g) => g.id === gid).data.tabs;
const metaTsBefore = (await db.get(gid)).ts;
await G.removeTab(x.id);
assert.ok((await db.get(x.id)).deleted && (await db.get(x.id)).dirty);
assert.equal((await db.get(gid)).ts, metaTsBefore, 'group meta untouched');

// removing the last tab tombstones the group
await G.removeTab(y.id);
assert.ok((await db.get(gid)).deleted);
assert.equal((await G.listGroups()).length, 1);

// meta edit doesn't touch tabs; delete group tombstones meta + tabs
await G.updateGroup('g:legacy1', { title: 'renamed' });
assert.equal((await G.listGroups())[0].data.title, 'renamed');
await G.deleteGroup('g:legacy1');
assert.equal((await G.listGroups()).length, 0);
assert.ok((await db.get('t:legacy1-1')).deleted);

// concurrent edits: simulate a remote device's newer record for another tab of the same group
const g2 = await G.createGroup([{ url: 'https://p', title: 'P' }, { url: 'https://q', title: 'Q' }]);
const [p, q] = (await G.listGroups())[0].data.tabs;
await G.removeTab(p.id);                                       // local: remove P
await db.put({ ...(await db.get(q.id)), ts: Date.now() + 1e6, dirty: false,
  data: { ...(await db.get(q.id)).data, title: 'Q (edited remotely)' } }); // remote: edit Q
const merged = (await G.listGroups())[0].data.tabs;
assert.deepEqual(merged.map((t) => t.title), ['Q (edited remotely)'], 'both edits survive');

// storing a URL that's already listed is silently dropped, keeping the existing title
assert.equal(await G.createGroup([{ url: 'https://q', title: 'new title' }]), null);
const g3 = await G.createGroup([{ url: 'https://q', title: 'dup' }, { url: 'https://r', title: 'R' }, { url: 'https://r', title: 'R2' }]);
assert.deepEqual((await G.listGroups()).find((g) => g.id === g3).data.tabs.map((t) => t.title), ['R']);
assert.ok((await G.listGroups()).some((g) => g.data.tabs.some((t) => t.title === 'Q (edited remotely)')));

// import keeps order and ids are per-tab
await G.importGroups([[{ url: 'https://1', title: '1' }], [{ url: 'https://2', title: '2' }]]);
const titles = (await G.listGroups()).map((g) => g.data.tabs[0].title).filter((t) => t === '1' || t === '2');
assert.deepEqual(titles.slice(0, 2), ['1', '2']);

console.log('all tests passed');
