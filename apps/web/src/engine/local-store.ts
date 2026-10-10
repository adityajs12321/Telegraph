// IndexedDB database for one user.

import { toWire, type ChatMessage, type Identity, type MessageStatus, type PublicKeys, type StoredMessage } from "@telegraph/shared";
import { openDb, request, transact } from "./db";

// Logged in account
export interface Account extends Identity {
  name: string;
  email: string;
}

const ME = "me";

export class LocalStore {
  private constructor(private db: IDBDatabase) {}

  static async open(name: string): Promise<LocalStore> {
    return new LocalStore(await openDb(`telegraph-${name}`));
  }

  close() {
    this.db.close();
  }

  // ---- Messages ----

  // Returns false if it was already saved.
  saveMessage(msg: ChatMessage, status: MessageStatus): Promise<boolean> {
    return transact(this.db, "messages", "readwrite", async (tx) => {
      const messages = tx.objectStore("messages");
      if (await request(messages.getKey(msg.id))) return false;
      messages.put({ ...toWire(msg), status } satisfies StoredMessage);
      return true;
    });
  }

  setStatus(id: string, status: MessageStatus, from?: MessageStatus): Promise<boolean> {
    return transact(this.db, "messages", "readwrite", async (tx) => {
      const messages = tx.objectStore("messages");
      const msg = (await request(messages.get(id))) as StoredMessage | undefined;
      if (!msg || (from && msg.status !== from)) return false;
      messages.put({ ...msg, status });
      return true;
    });
  }

  async messagesWithStatus(status: MessageStatus): Promise<StoredMessage[]> {
    const rows = await transact(this.db, "messages", "readonly", (tx) =>
      request(tx.objectStore("messages").index("status").getAll(status))
    );
    return (rows as StoredMessage[]).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  }

  // The newest `limit` messages, sorted oldest to newest.
  recentMessages(limit = 500): Promise<StoredMessage[]> {
    return transact(this.db, "messages", "readonly", (tx) => {
      const rows: StoredMessage[] = [];
      return new Promise((resolve, reject) => {
        const cursor = tx.objectStore("messages").index("timestamp").openCursor(null, "prev");
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || rows.length >= limit) return resolve(rows.reverse());
          rows.push(c.value as StoredMessage);
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    });
  }

  // ---- Logged in account ----

  account(): Promise<Account | null> {
    return transact(this.db, "identity", "readonly", async (tx) => {
      return ((await request(tx.objectStore("identity").get(ME))) as Account | undefined) ?? null;
    });
  }

  saveAccount(a: Account): Promise<void> {
    return transact(this.db, "identity", "readwrite", async (tx) => {
      tx.objectStore("identity").put(a, ME);
    });
  }

  // Logout: forgets these keys
  clearAccount(signPub: string): Promise<void> {
    return transact(this.db, "identity", "readwrite", async (tx) => {
      const identity = tx.objectStore("identity");
      const a = (await request(identity.get(ME))) as Account | undefined;
      if (a?.signPub === signPub) identity.delete(ME);
    });
  }

  // ---- Contacts ----

  contactKeys(name: string): Promise<PublicKeys | null> {
    return transact(this.db, "contacts", "readonly", async (tx) => {
      const row = (await request(tx.objectStore("contacts").get(name))) as (PublicKeys & { name: string }) | undefined;
      return row ? { signPub: row.signPub, boxPub: row.boxPub } : null;
    });
  }

  pinContactKeys(name: string, keys: PublicKeys): Promise<void> {
    return transact(this.db, "contacts", "readwrite", async (tx) => {
      const contacts = tx.objectStore("contacts");
      if (!(await request(contacts.getKey(name)))) contacts.put({ name, signPub: keys.signPub, boxPub: keys.boxPub });
    });
  }

  // They logged in on a new device.
  replaceContactKeys(name: string, keys: PublicKeys): Promise<void> {
    return transact(this.db, "contacts", "readwrite", async (tx) => {
      tx.objectStore("contacts").put({ name, signPub: keys.signPub, boxPub: keys.boxPub });
    });
  }

  // ---- Address book ----

  async contactList(): Promise<string[]> {
    const names = await transact(this.db, "address_book", "readonly", (tx) =>
      request(tx.objectStore("address_book").getAllKeys())
    );
    return (names as string[]).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  // Returns false if they were already in the list.
  addContact(name: string): Promise<boolean> {
    return transact(this.db, "address_book", "readwrite", async (tx) => {
      const book = tx.objectStore("address_book");
      if (await request(book.getKey(name))) return false;
      book.put({ name, addedAt: new Date().toISOString() });
      return true;
    });
  }
}
