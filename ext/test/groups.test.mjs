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

// undo brings back a removed last tab together with its group
const g4 = await G.createGroup([{ url: 'https://u', title: 'U' }]);
const [u] = (await G.listGroups()).find((g) => g.id === g4).data.tabs;
const snap = await G.removeTab(u.id);
assert.ok((await db.get(g4)).deleted);
await G.undo(snap);
assert.deepEqual((await G.listGroups()).find((g) => g.id === g4).data.tabs.map((t) => t.url), ['https://u']);
assert.ok((await db.get(g4)).dirty, 'undo is pushed like any edit');

// undo a whole-group delete
await G.undo(await G.deleteGroup(g4));
assert.ok((await G.listGroups()).some((g) => g.id === g4));

// move: reorder within a group, then move across groups (emptied source group disappears)
const m = await G.createGroup([{ url: 'https://m1', title: 'm1' }, { url: 'https://m2', title: 'm2' }, { url: 'https://m3', title: 'm3' }]);
const mt = () => G.listGroups().then((gs) => gs.find((g) => g.id === m)?.data.tabs.map((t) => t.title));
const [m1, , m3] = (await G.listGroups()).find((g) => g.id === m).data.tabs;
await G.moveTab(m3.id, m, m1.id);
assert.deepEqual(await mt(), ['m3', 'm1', 'm2']);
await G.moveTab(m3.id, m); // to the end
assert.deepEqual(await mt(), ['m1', 'm2', 'm3']);
await G.moveTab(u.id, m, m1.id);
assert.deepEqual(await mt(), ['U', 'm1', 'm2', 'm3']);
assert.ok((await db.get(g4)).deleted, 'emptied group is tombstoned');

// pinned groups sort above starred ones, which sort above the rest
const [pA, pB, pC] = [await G.createGroup([{ url: 'https://pa', title: 'pa' }]),
  await G.createGroup([{ url: 'https://pb', title: 'pb' }]), await G.createGroup([{ url: 'https://pc', title: 'pc' }])];
await G.updateGroup(pA, { pinned: true });
await G.updateGroup(pB, { starred: true });
const order = (await G.listGroups()).map((g) => g.id);
assert.ok(order.indexOf(pA) === 0 && order.indexOf(pB) === 1 && order.indexOf(pC) > 1, 'pinned > starred > rest');

// import keeps order and ids are per-tab
await G.importGroups([[{ url: 'https://1', title: '1' }], [{ url: 'https://2', title: '2' }]]);
const titles = (await G.listGroups()).map((g) => g.data.tabs[0].title).filter((t) => t === '1' || t === '2');
assert.deepEqual(titles.slice(0, 2), ['1', '2']);

// createGroup keeps extra meta (Chrome tab group name/color, device)
const cg = await G.createGroup([{ url: 'https://cg', title: 'cg' }], { title: 'Work', chromeGroup: { color: 'blue' }, device: 'Edge on Windows' });
const cgData = (await G.listGroups()).find((g) => g.id === cg).data;
assert.equal(cgData.title, 'Work');
assert.deepEqual(cgData.chromeGroup, { color: 'blue' });
assert.equal(cgData.device, 'Edge on Windows');

// imports carry the importing device
const before = new Set((await G.listGroups()).map((g) => g.id));
await G.importGroups([[{ url: 'https://imp', title: 'imp' }]], { device: 'Chrome on macOS', deviceId: 'dev-2' });
const imported = (await G.listGroups()).find((g) => !before.has(g.id));
assert.equal(imported.data.deviceId, 'dev-2');

// quick archive: fixed id, appends in order, skips URLs already archived (even if listed elsewhere it's still added)
assert.equal(await G.addToArchive([{ url: 'https://arch1', title: 'a1' }, { url: 'https://cg', title: 'dup of a group tab' }]), 2);
assert.equal(await G.addToArchive([{ url: 'https://arch1', title: 'again' }, { url: 'https://arch2', title: 'a2' }]), 1);
let arch = (await G.listGroups()).find((g) => g.id === G.ARCHIVE).data;
assert.equal(arch.archive, true);
assert.deepEqual(arch.tabs.map((t) => t.title), ['a1', 'dup of a group tab', 'a2']);
// emptying the archive tombstones it; adding again brings it back
for (const t of arch.tabs) await G.removeTab(t.id);
assert.ok((await db.get(G.ARCHIVE)).deleted);
assert.equal(await G.addToArchive([{ url: 'https://arch3', title: 'a3' }]), 1);
arch = (await G.listGroups()).find((g) => g.id === G.ARCHIVE).data;
assert.deepEqual(arch.tabs.map((t) => t.title), ['a3']);
// dragging a tab into the archive works even after it was emptied
for (const t of arch.tabs) await G.removeTab(t.id);
await G.moveTab((await G.listGroups()).find((g) => g.id === cg).data.tabs[0].id, G.ARCHIVE);
assert.deepEqual((await G.listGroups()).find((g) => g.id === G.ARCHIVE)?.data.tabs.map((t) => t.url), ['https://cg']);

// updater: version compare
const { isNewer } = await import('../src/lib/updater.js');
assert.ok(isNewer('0.3.2', '0.3.1'));
assert.ok(isNewer('v0.10.0', '0.9.9'), 'numeric, not lexical; tolerates a v prefix');
assert.ok(isNewer('1.0', '0.9.9'));
assert.ok(!isNewer('0.3.1', '0.3.1'));
assert.ok(!isNewer('0.3.0', '0.3.1'));

console.log('all tests passed');
