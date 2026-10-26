// Tiny IndexedDB key-value store for downloaded audio, book text and covers.

const DB_NAME = 'books';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const store = t.objectStore('kv');
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (key) => tx('readonly', (s) => s.get(key)),
  set: (key, value) => tx('readwrite', (s) => s.put(value, key)),
  del: (key) => tx('readwrite', (s) => s.delete(key)),
  async keys(prefix = '') {
    const all = await tx('readonly', (s) => s.getAllKeys());
    return all.filter((k) => String(k).startsWith(prefix));
  },
  async delPrefix(prefix) {
    for (const k of await this.keys(prefix)) await this.del(k);
  },
};

// Ask the browser not to evict our downloads when space is low.
export async function persist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
}
