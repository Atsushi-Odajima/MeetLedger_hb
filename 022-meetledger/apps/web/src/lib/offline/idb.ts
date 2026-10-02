// Tiny promise wrapper around IndexedDB for the page-side offline stores.
// Stores:
//   outbox      queued mutations (notes saves, action status changes) — see outbox.ts
//   kv          last known server copies (notes) and small flags
//   recordings  browser recordings that are not uploaded yet (chunks persisted while recording)

export const DB_NAME = 'meetledger';
export const DB_VERSION = 1;
export type StoreName = 'outbox' | 'kv' | 'recordings';

let dbPromise: Promise<IDBDatabase> | null = null;

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error('IndexedDB is not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Closes and forgets the connection (tests, logout). */
export async function closeDb() {
  if (!dbPromise) return;
  try {
    (await dbPromise).close();
  } catch {
    /* ignore */
  }
  dbPromise = null;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    const r = fn(t.objectStore(store));
    r.onsuccess = () => {
      result = r.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
  },
  delete(store: StoreName, key: IDBValidKey): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  },
  all<T>(store: StoreName): Promise<T[]> {
    return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  clear(store: StoreName): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  },
  /** Read-modify-write inside one transaction (atomic w.r.t. other IndexedDB writers). */
  async update<T>(store: StoreName, key: IDBValidKey, fn: (cur: T | undefined) => T | undefined): Promise<T | undefined> {
    const db = await openDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      let next: T | undefined;
      const g = s.get(key);
      g.onsuccess = () => {
        next = fn(g.result as T | undefined);
        if (next === undefined) s.delete(key);
        else if (s.keyPath) s.put(next);
        else s.put(next, key);
      };
      t.oncomplete = () => resolve(next);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  wrap,
};
