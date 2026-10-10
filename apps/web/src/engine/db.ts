// IndexedDB schema and helpers.
// To change the schema, append a step.
const MIGRATIONS: ((db: IDBDatabase) => void)[] = [
  // 1: baseline
  (db) => {
    const messages = db.createObjectStore("messages", { keyPath: "id" });
    messages.createIndex("timestamp", "timestamp");
    messages.createIndex("status", "status");
    // This device's account and keys under the key "me".
    db.createObjectStore("identity");
    // Public keys of people we've talked to
    db.createObjectStore("contacts", { keyPath: "name" });
    // People shown in the contact list
    db.createObjectStore("address_book", { keyPath: "name" });
  },
];

export function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, MIGRATIONS.length);
    open.onupgradeneeded = (e) => {
      for (let v = e.oldVersion; v < MIGRATIONS.length; v++) MIGRATIONS[v](open.result);
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () =>
      reject(open.error?.name === "VersionError" ? new Error("local data is from a newer version of the app; reload the page") : open.error);
  });
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function transact<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
  try {
    const result = await fn(tx);
    await committed;
    return result;
  } catch (err) {
    committed.catch(() => {});
    try {
      tx.abort();
    } catch {
      // done
    }
    throw err;
  }
}
