// SQLite Database

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, Identity, MessageStatus, PublicKeys, StoredMessage } from "@telegraph/shared";

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
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY,
        sender    TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body      TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE TABLE IF NOT EXISTS identity (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        sign_pub  TEXT NOT NULL,
        sign_priv TEXT NOT NULL,
        box_pub   TEXT NOT NULL,
        box_priv  TEXT NOT NULL
      );
      -- Public keys of people we've talked to, pinned on first use.
      CREATE TABLE IF NOT EXISTS contacts (
        name     TEXT PRIMARY KEY,
        sign_pub TEXT NOT NULL,
        box_pub  TEXT NOT NULL
      );
    `);
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

  // ---- Device identity ----

  identity(): Identity | null {
    const row = this.db.prepare(`SELECT * FROM identity WHERE id = 1`).get() as
      | { sign_pub: string; sign_priv: string; box_pub: string; box_priv: string }
      | undefined;
    return row
      ? { signPub: row.sign_pub, signPriv: row.sign_priv, boxPub: row.box_pub, boxPriv: row.box_priv }
      : null;
  }

  saveIdentity(id: Identity) {
    this.db
      .prepare(`INSERT INTO identity (id, sign_pub, sign_priv, box_pub, box_priv) VALUES (1, ?, ?, ?, ?)`)
      .run(id.signPub, id.signPriv, id.boxPub, id.boxPriv);
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
