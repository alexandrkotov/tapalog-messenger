/**
 * What this device keeps between visits, in IndexedDB: who is signed in,
 * the chat list, the latest messages of chats that were opened, and the
 * outbox with its files. Opening the app without a network shows all of
 * that, and the outbox goes once the server is reachable again.
 *
 * A small key-value store over one object store, no library. Every call
 * swallows errors: private windows and full disks just mean nothing is kept.
 *
 * Files are stored as their bytes, not as Blobs: Safari refuses Blobs in
 * IndexedDB in private windows, and then the whole write fails. Writes run
 * one after another, so a clear is never overtaken by a write started
 * before it.
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

/** How a Blob is kept: its bytes and type. */
interface StoredBlob {
  $blob: ArrayBuffer;
  type: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

async function pack(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { $blob: await value.arrayBuffer(), type: value.type } satisfies StoredBlob;
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (isPlain(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await pack(v)])));
  return value;
}

function unpack(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpack);
  if (!isPlain(value)) return value;
  if (value.$blob instanceof ArrayBuffer) return new Blob([value.$blob], { type: String(value.type ?? "") });
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
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
            out.set(String(cursor.key), unpack(cursor.value));
            cursor.continue();
          };
          req.onerror = () => resolve(out);
        }),
    )
    .catch(() => new Map());
}

/** Writes all entries in one transaction, deleting keys whose value is undefined. */
export function putMany(entries: [string, unknown][]): Promise<unknown> {
  return serial(async () => {
    const packed = await Promise.all(entries.map(async ([key, value]) => [key, await pack(value)] as const)).catch(() => []);
    return run("readwrite", (store) => {
      for (const [key, value] of packed) {
        if (value === undefined) store.delete(key);
        else store.put(value, key);
      }
    });
  });
}

export function clearAll(): Promise<unknown> {
  return serial(() => run("readwrite", (store) => store.clear()));
}
