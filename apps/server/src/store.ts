// Server persistence (PostgreSQL via Drizzle)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Envelope, PublicKeys } from "@telegraph/shared";
import { envelopes, identities } from "./schema.js";

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

  // Returns false if the name was already taken (two devices racing for it).
  async register(name: string, keys: PublicKeys): Promise<boolean> {
    const inserted = await this.db
      .insert(identities)
      .values({ name, ...keys })
      .onConflictDoNothing()
      .returning({ name: identities.name });
    return inserted.length > 0;
  }

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
    const purged = await this.db
      .delete(envelopes)
      .where(lt(envelopes.createdAt, cutoff))
      .returning({ id: envelopes.id });
    return purged.length;
  }
}
