// Schema migration changes for the local database, applied in order.

import type { DatabaseSync } from "node:sqlite";

type Migration = string | ((db: DatabaseSync) => void);

const MIGRATIONS: Migration[] = [
  // 1: baseline. Also brings files from before versioning up to date
  (db) => {
    // Version 2
    const columns = db.prepare(`PRAGMA table_info(identity)`).all() as { name: string }[];
    if (columns.length && !columns.some((c) => c.name === "name")) db.exec(`DROP TABLE identity`);

    db.exec(`
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
      -- Present only while logged in.
      CREATE TABLE IF NOT EXISTS identity (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        name      TEXT NOT NULL,
        email     TEXT NOT NULL,
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
      -- People shown in the contact list (added by hand or by messaging).
      CREATE TABLE IF NOT EXISTS address_book (
        name     TEXT PRIMARY KEY,
        added_at TEXT NOT NULL
      );
    `);
  },

  // 2: drop the per-file `owner` table from before each user had their own database.
  `DROP TABLE IF EXISTS owner;`,
];

const versionOf = (db: DatabaseSync) =>
  (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;

export function migrate(db: DatabaseSync) {
  if (versionOf(db) === MIGRATIONS.length) return;
  // IMMEDIATE takes the write lock up front, so two apps opening the same file can't both migrate it.
  db.exec(`BEGIN IMMEDIATE`);
  try {
    const from = versionOf(db);
    if (from > MIGRATIONS.length) {
      throw new Error(`database is from a newer version of the app (schema v${from}); update the app`);
    }
    for (let v = from; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v];
      if (typeof step === "string") db.exec(step);
      else step(db);
    }
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}
