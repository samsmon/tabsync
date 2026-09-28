// Tiny IndexedDB wrapper. Data lives on disk, not in RAM.
// records: { id, ts, deleted, dirty, data }
//   "g:<uuid>" group meta: { title, createdAt, locked, starred }
//   "t:<...>"  tab:        { groupId, url, title, pos }  (indexed by url and groupId)
//   bare uuid  legacy v1 whole-group record, split by migrateLegacy()
let dbp;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tabsync', 3);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) db.createObjectStore('kv');
      if (e.oldVersion < 2) db.createObjectStore('records', { keyPath: 'id' });
      if (e.oldVersion < 3) {
        // lookups by URL (dedupe) and by group (siblings) without scanning every record;
        // tombstones have data: null, so they stay out of both indexes
        const records = req.transaction.objectStore('records');
        records.createIndex('url', 'data.url');
        records.createIndex('groupId', 'data.groupId');
      }
      if (e.oldVersion === 1) {
        const tx = req.transaction;
        const records = tx.objectStore('records');
        tx.objectStore('groups').getAll().onsuccess = (ev) => {
          for (const g of ev.target.result) records.put(g);
          db.deleteObjectStore('groups');
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  async get(id) { return wrap((await store('records')).get(id)); },
  async put(r) { return wrap((await store('records', 'readwrite')).put(r)); },
  async putMany(rs) {
    const tx = (await open()).transaction('records', 'readwrite');
    const s = tx.objectStore('records');
    for (const r of rs) s.put(r);
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  async all() { return wrap((await store('records')).getAll()); },
  async byIndex(name, key) { return wrap((await store('records')).index(name).getAll(key)); },
  async kvGet(k) { return wrap((await store('kv')).get(k)); },
  async kvSet(k, v) { return wrap((await store('kv', 'readwrite')).put(v, k)); },
};
