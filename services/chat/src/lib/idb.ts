/** Minimal promise wrapper around IndexedDB (key/value object stores). */

export function idbFactory(): IDBFactory {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available in this browser");
  return indexedDB;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

export function openDb(name: string, version: number, stores: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idbFactory().open(name, version);
    r.onupgradeneeded = () => {
      for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error(`Couldn't open IndexedDB database ${name}`));
    r.onblocked = () => reject(new Error(`IndexedDB database ${name} is blocked by another tab`));
  });
}

async function withStore<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const tx = db.transaction(store, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
  const result = await req(fn(tx.objectStore(store)));
  await done;
  return result;
}

export const idbGet = <T>(db: IDBDatabase, store: string, key: IDBValidKey) =>
  withStore(db, store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
export const idbPut = (db: IDBDatabase, store: string, key: IDBValidKey, value: unknown) =>
  withStore(db, store, "readwrite", (s) => s.put(value, key));
export const idbDelete = (db: IDBDatabase, store: string, key: IDBValidKey) =>
  withStore(db, store, "readwrite", (s) => s.delete(key));
export const idbClear = (db: IDBDatabase, store: string) => withStore(db, store, "readwrite", (s) => s.clear());

export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = idbFactory().deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error ?? new Error(`Couldn't delete ${name}`));
    // "blocked" means another connection is open; the delete completes once it closes.
    r.onblocked = () => resolve();
  });
}
