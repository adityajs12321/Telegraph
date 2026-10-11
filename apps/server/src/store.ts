// Server persistence (PostgreSQL via Drizzle)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Envelope, PublicKeys } from "@telegraph/shared";
import { bounces, envelopes, identities, loginCodes, receipts } from "./schema.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const MAX_CACHED_KEYS = 100_000;

// True if a query failed because every database connection stayed busy for too long. The server answers 503
// then, instead of letting requests queue up without limit. Drizzle may wrap the driver's error as `cause`.
export function isDatabaseBusy(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (/timeout exceeded when trying to connect/i.test(e.message)) return true;
  }
  return false;
}

export class Store {
  private pool: pg.Pool;
  private db;
  // Public keys are read on every signed request but only change on login, so they're kept in memory.
  // Assumes a single server process, like the hub.
  private keys = new Map<string, PublicKeys>();
  private keysVersion = 0; // bumped whenever keys change, so a lookup that raced the change isn't cached

  // Every query is a network round trip to the database, so connections spend most of their time waiting;
  // more of them lets more requests wait at once. `waitMs` bounds how long a request queues for one.
  constructor(databaseUrl: string, { poolSize = 20, waitMs = 5000 } = {}) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize, connectionTimeoutMillis: waitMs });
    this.db = drizzle(this.pool);
  }

  async migrate() {
    await migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  async close() {
    await this.pool.end();
  }

  async keysFor(name: string): Promise<PublicKeys | null> {
    const cached = this.keys.get(name);
    if (cached) return cached;
    const version = this.keysVersion;
    const [row] = await this.db
      .select({ signPub: identities.signPub, boxPub: identities.boxPub })
      .from(identities)
      .where(eq(identities.name, name));
    if (row && version === this.keysVersion) {
      if (this.keys.size >= MAX_CACHED_KEYS) this.keys.clear();
      this.keys.set(name, row);
    }
    return row ?? null;
  }

  // ---- Accounts ----

  async nameForEmail(email: string): Promise<string | null> {
    const [row] = await this.db.select({ name: identities.name }).from(identities).where(eq(identities.email, email));
    return row?.name ?? null;
  }

  // Returns false if the name (or email) is already taken.
  async createAccount(email: string, name: string, keys: PublicKeys): Promise<boolean> {
    const inserted = await this.db
      .insert(identities)
      .values({ name, email, ...keys })
      .onConflictDoNothing()
      .returning({ name: identities.name });
    return inserted.length > 0;
  }

  // A new device logged in. Envelopes still waiting were encrypted for the old device's key and
  // can't be opened by the new one, so they're dropped and recorded as bounces for their senders.
  async replaceKeys(name: string, keys: PublicKeys): Promise<Array<{ id: string; sender: string }>> {
    return this.db.transaction(async (tx) => {
      await tx.update(identities).set(keys).where(eq(identities.name, name));
      const dropped = await tx
        .delete(envelopes)
        .where(eq(envelopes.recipient, name))
        .returning({ id: envelopes.id, sender: envelopes.sender });
      if (dropped.length > 0) await tx.insert(bounces).values(dropped).onConflictDoNothing();
      return dropped;
    }).finally(() => {
      this.keysVersion++;
      this.keys.delete(name);
    });
  }

  // ---- Login codes ----

  async loginCodeSentAt(email: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ createdAt: loginCodes.createdAt })
      .from(loginCodes)
      .where(eq(loginCodes.email, email));
    return row?.createdAt ?? null;
  }

  // Replaces any earlier code for this email.
  async saveLoginCode(email: string, codeHash: string, expiresAt: Date) {
    const fields = { codeHash, expiresAt, attempts: 0, createdAt: new Date() };
    await this.db
      .insert(loginCodes)
      .values({ email, ...fields })
      .onConflictDoUpdate({ target: loginCodes.email, set: fields });
  }

  // Uses up one attempt and returns the code's hash, or null if there's no live code with attempts left.
  // A single UPDATE, so parallel guesses can't get more than `maxAttempts` between them.
  async takeLoginAttempt(email: string, maxAttempts: number): Promise<string | null> {
    const [row] = await this.db
      .update(loginCodes)
      .set({ attempts: sql`${loginCodes.attempts} + 1` })
      .where(
        and(eq(loginCodes.email, email), gt(loginCodes.expiresAt, new Date()), lt(loginCodes.attempts, maxAttempts))
      )
      .returning({ codeHash: loginCodes.codeHash });
    return row?.codeHash ?? null;
  }

  async deleteLoginCode(email: string) {
    await this.db.delete(loginCodes).where(eq(loginCodes.email, email));
  }

  // ---- Envelopes ----

  // Stores the envelope unless its recipient already has `max` waiting, and returns false in that case.
  // Ignores duplicates, so senders can safely retry. A resent bounce is resolved.
  // One statement, so it costs a single round trip to the database and is atomic on its own.
  async deposit(env: Envelope, max: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: number }>(
      `WITH queued AS (SELECT count(*)::int AS n FROM envelopes WHERE recipient = $2),
       inserted AS (
         INSERT INTO envelopes (id, recipient, sender, payload)
         SELECT $1, $2, $3, $4 FROM queued WHERE n < $5
         ON CONFLICT DO NOTHING
       ),
       unbounced AS (DELETE FROM bounces WHERE id = $1 AND sender = $3 AND (SELECT n FROM queued) < $5)
       SELECT n FROM queued`,
      [env.id, env.to, env.from, JSON.stringify(env), max]
    );
    return rows[0].n < max;
  }

  async pendingFor(recipient: string): Promise<Envelope[]> {
    const rows = await this.db
      .select({ payload: envelopes.payload })
      .from(envelopes)
      .where(eq(envelopes.recipient, recipient))
      .orderBy(asc(envelopes.createdAt));
    return rows.map((r) => r.payload);
  }

  async bouncesFor(sender: string): Promise<string[]> {
    const rows = await this.db.select({ id: bounces.id }).from(bounces).where(eq(bounces.sender, sender));
    return rows.map((r) => r.id);
  }

  // Only deletes envelopes addressed to `recipient`. Returns the ones removed, so senders can be told,
  // and keeps a receipt for each until the sender confirms it.
  // One statement, so a single round trip.
  async remove(recipient: string, ids: string[]): Promise<Array<{ id: string; sender: string }>> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ id: string; sender: string }>(
      `WITH removed AS (DELETE FROM envelopes WHERE recipient = $1 AND id = ANY($2) RETURNING id, sender),
       kept AS (INSERT INTO receipts (id, sender) SELECT id, sender FROM removed ON CONFLICT DO NOTHING)
       SELECT id, sender FROM removed`,
      [recipient, ids]
    );
    return rows;
  }

  async receiptsFor(sender: string): Promise<string[]> {
    const rows = await this.db.select({ id: receipts.id }).from(receipts).where(eq(receipts.sender, sender));
    return rows.map((r) => r.id);
  }

  async clearReceipts(sender: string, ids: string[]) {
    if (ids.length === 0) return;
    await this.db.delete(receipts).where(and(eq(receipts.sender, sender), inArray(receipts.id, ids)));
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    await this.db.delete(loginCodes).where(lt(loginCodes.expiresAt, new Date()));
    await this.db.delete(bounces).where(lt(bounces.createdAt, cutoff));
    await this.db.delete(receipts).where(lt(receipts.createdAt, cutoff));
    const purged = await this.db
      .delete(envelopes)
      .where(lt(envelopes.createdAt, cutoff))
      .returning({ id: envelopes.id });
    return purged.length;
  }
}
