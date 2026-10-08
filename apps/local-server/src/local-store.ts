// SQLite database for one user: <dataDir>/<username>.db

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, Identity, MessageStatus, PublicKeys, StoredMessage } from "@telegraph/shared";
import { migrate } from "./local-migrations.js";

// Logged in account
export interface Account extends Identity {
  name: string;
  email: string;
}

interface MessageRow {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  timestamp: string;
  status: MessageStatus;
}

export class LocalStore {
  private db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Wait while another app on this machine has the file locked.
    this.db.exec(`PRAGMA busy_timeout = 5000`);
    // Keep everything in <name>.db itself (no -wal file), so the file alone is a complete copy.
    this.db.exec(`PRAGMA journal_mode = DELETE`);
    migrate(this.db);
  }

  // ---- Messages ----

  saveMessage(msg: ChatMessage, status: MessageStatus): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, sender, recipient, body, timestamp, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(msg.id, msg.from, msg.to, msg.body, msg.timestamp, status);
    return result.changes > 0;
  }

  setStatus(id: string, status: MessageStatus) {
    this.db.prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(status, id);
  }

  message(id: string): StoredMessage | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  messagesWithStatus(status: MessageStatus): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE status = ? ORDER BY timestamp`)
      .all(status) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  recentMessages(limit = 500): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?)
         ORDER BY timestamp ASC`
      )
      .all(limit) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  // ---- Logged in account ----

  account(): Account | null {
    const row = this.db.prepare(`SELECT * FROM identity WHERE id = 1`).get() as
      | { name: string; email: string; sign_pub: string; sign_priv: string; box_pub: string; box_priv: string }
      | undefined;
    return row
      ? {
          name: row.name,
          email: row.email,
          signPub: row.sign_pub,
          signPriv: row.sign_priv,
          boxPub: row.box_pub,
          boxPriv: row.box_priv,
        }
      : null;
  }

  saveAccount(a: Account) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO identity (id, name, email, sign_pub, sign_priv, box_pub, box_priv)
         VALUES (1, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.name, a.email, a.signPub, a.signPriv, a.boxPub, a.boxPriv);
  }

  // Logout: forgets these keys
  clearAccount(signPub: string) {
    this.db.prepare(`DELETE FROM identity WHERE sign_pub = ?`).run(signPub);
  }

  close() {
    this.db.close();
  }

  // ---- Contacts ----

  contactKeys(name: string): PublicKeys | null {
    const row = this.db.prepare(`SELECT sign_pub, box_pub FROM contacts WHERE name = ?`).get(name) as
      | { sign_pub: string; box_pub: string }
      | undefined;
    return row ? { signPub: row.sign_pub, boxPub: row.box_pub } : null;
  }

  pinContactKeys(name: string, keys: PublicKeys) {
    this.db
      .prepare(`INSERT OR IGNORE INTO contacts (name, sign_pub, box_pub) VALUES (?, ?, ?)`)
      .run(name, keys.signPub, keys.boxPub);
  }

  // They logged in on a new device.
  replaceContactKeys(name: string, keys: PublicKeys) {
    this.db
      .prepare(`INSERT OR REPLACE INTO contacts (name, sign_pub, box_pub) VALUES (?, ?, ?)`)
      .run(name, keys.signPub, keys.boxPub);
  }

  // ---- Address book ----

  contactList(): string[] {
    const rows = this.db.prepare(`SELECT name FROM address_book ORDER BY name COLLATE NOCASE`).all() as {
      name: string;
    }[];
    return rows.map((r) => r.name);
  }

  // Returns false if they were already in the list.
  addContact(name: string): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO address_book (name, added_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
    return result.changes > 0;
  }

  // Lists everyone `me` has already exchanged messages with (for databases from before the address book).
  addContactsFromMessages(me: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO address_book (name, added_at)
         SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS name, MIN(timestamp)
         FROM messages GROUP BY name`
      )
      .run(me);
  }
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    type: "message",
    id: r.id,
    from: r.sender,
    to: r.recipient,
    body: r.body,
    timestamp: r.timestamp,
    status: r.status,
  };
}
