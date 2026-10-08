// Server persistence (PostgreSQL via Drizzle)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Envelope, PublicKeys } from "@telegraph/shared";
import { envelopes, identities, loginCodes } from "./schema.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export class Store {
  private pool: pg.Pool;
  private db;

  constructor(databaseUrl: string) {
    // A small pool is plenty for one server process and keeps memory low.
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    this.db = drizzle(this.pool);
  }

  async migrate() {
    await migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  async close() {
    await this.pool.end();
  }

  async keysFor(name: string): Promise<PublicKeys | null> {
    const [row] = await this.db
      .select({ signPub: identities.signPub, boxPub: identities.boxPub })
      .from(identities)
      .where(eq(identities.name, name));
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
  // can't be opened by the new one, so they're dropped too.
  async replaceKeys(name: string, keys: PublicKeys) {
    await this.db.transaction(async (tx) => {
      await tx.update(identities).set(keys).where(eq(identities.name, name));
      await tx.delete(envelopes).where(eq(envelopes.recipient, name));
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

  async countFor(recipient: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(envelopes).where(eq(envelopes.recipient, recipient));
    return row.n;
  }

  // Ignores duplicates, so senders can safely retry.
  async deposit(env: Envelope) {
    await this.db
      .insert(envelopes)
      .values({ id: env.id, recipient: env.to, sender: env.from, payload: env })
      .onConflictDoNothing();
  }

  async pendingFor(recipient: string): Promise<Envelope[]> {
    const rows = await this.db
      .select({ payload: envelopes.payload })
      .from(envelopes)
      .where(eq(envelopes.recipient, recipient))
      .orderBy(asc(envelopes.createdAt));
    return rows.map((r) => r.payload);
  }

  // Only deletes envelopes addressed to `recipient`. Returns the ones removed, so senders can be told.
  async remove(recipient: string, ids: string[]): Promise<Array<{ id: string; sender: string }>> {
    if (ids.length === 0) return [];
    return this.db
      .delete(envelopes)
      .where(and(eq(envelopes.recipient, recipient), inArray(envelopes.id, ids)))
      .returning({ id: envelopes.id, sender: envelopes.sender });
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    await this.db.delete(loginCodes).where(lt(loginCodes.expiresAt, new Date()));
    const purged = await this.db
      .delete(envelopes)
      .where(lt(envelopes.createdAt, cutoff))
      .returning({ id: envelopes.id });
    return purged.length;
  }
}
