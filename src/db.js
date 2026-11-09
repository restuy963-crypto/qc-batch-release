// Penyimpanan lokal di perangkat (IndexedDB). Tidak ada data yang dikirim ke server.
const DB_NAME = 'qc-batch-release';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('refs')) db.createObjectStore('refs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('audit')) db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaksi dibatalkan'));
  }));
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  put: (store, value) => tx(store, 'readwrite', s => wrap(s.put(value))),
  get: (store, key) => tx(store, 'readonly', s => wrap(s.get(key))),
  all: (store) => tx(store, 'readonly', s => wrap(s.getAll())),
  del: (store, key) => tx(store, 'readwrite', s => wrap(s.delete(key))),
  clear: (store) => tx(store, 'readwrite', s => wrap(s.clear())),
  async kvGet(k) { const r = await this.get('kv', k); return r ? r.v : undefined; },
  kvSet(k, v) { return this.put('kv', { k, v }); },
  audit(event, detail) { return this.put('audit', { at: new Date().toISOString(), event, detail }); },
};
