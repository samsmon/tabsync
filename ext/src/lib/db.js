// Tiny IndexedDB wrapper. Data lives on disk, not in RAM.
// groups: { id, ts, deleted, dirty, data: { title, createdAt, locked, starred, tabs:[{url,title}] } }
let dbp;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tabsync', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('groups', { keyPath: 'id' });
      db.createObjectStore('kv');
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
  async get(id) { return wrap((await store('groups')).get(id)); },
  async put(g) { return wrap((await store('groups', 'readwrite')).put(g)); },
  async all() { return wrap((await store('groups')).getAll()); },
  async kvGet(k) { return wrap((await store('kv')).get(k)); },
  async kvSet(k, v) { return wrap((await store('kv', 'readwrite')).put(v, k)); },
};
