/**
 * What this device keeps between visits, in IndexedDB: who is signed in,
 * the chat list, the latest messages of chats that were opened, and the
 * outbox with its files. Opening the app without a network shows all of
 * that, and the outbox goes once the server is reachable again.
 *
 * A small key-value store over one object store, no library. Every call
 * swallows errors: private windows and full disks just mean nothing is kept.
 */

const DB_NAME = "tapalog-messenger";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open()
    .then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const req = work(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    )
    .catch(() => undefined);
}

export function getAll(): Promise<Map<string, unknown>> {
  return open()
    .then(
      (db) =>
        new Promise<Map<string, unknown>>((resolve) => {
          const out = new Map<string, unknown>();
          const req = db.transaction(STORE).objectStore(STORE).openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return resolve(out);
            out.set(String(cursor.key), cursor.value);
            cursor.continue();
          };
          req.onerror = () => resolve(out);
        }),
    )
    .catch(() => new Map());
}

/** Writes all entries in one transaction, deleting keys whose value is undefined. */
export function putMany(entries: [string, unknown][]): Promise<unknown> {
  return run("readwrite", (store) => {
    for (const [key, value] of entries) {
      if (value === undefined) store.delete(key);
      else store.put(value, key);
    }
  });
}

export function clearAll(): Promise<unknown> {
  return run("readwrite", (store) => store.clear());
}
