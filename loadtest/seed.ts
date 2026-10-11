// Creates (or removes) load-test accounts directly in the server's database, skipping email login,

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { generateIdentity } from "@telegraph/shared";

const PREFIX = "loadtest_";
const OUT = path.join(import.meta.dirname, "users.json");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("set DATABASE_URL to the server's database");
const arg = process.argv[2];
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

try {
  await db.query(`DELETE FROM envelopes WHERE recipient LIKE $1 OR sender LIKE $1`, [`${PREFIX}%`]);
  if (arg === "--clean") {
    const { rowCount } = await db.query(`DELETE FROM identities WHERE name LIKE $1`, [`${PREFIX}%`]);
    fs.rmSync(OUT, { force: true });
    console.log(`removed ${rowCount} load-test accounts`);
  } else {
    const count = Number(arg);
    if (!Number.isInteger(count) || count < 1) throw new Error("usage: seed.ts <count> | --clean");
    const users = [];
    for (let i = 1; i <= count; i++) {
      const id = await generateIdentity();
      const pkcs8 = Buffer.from(id.signPriv, "base64");
      if (pkcs8.length !== 48) throw new Error(`unexpected Ed25519 key length ${pkcs8.length}`);
      users.push({
        name: PREFIX + String(i).padStart(5, "0"),
        signPub: id.signPub,
        boxPub: id.boxPub,
        seed: pkcs8.subarray(16).toString("base64"),
      });
    }
    await db.query(
      `INSERT INTO identities (name, email, sign_pub, box_pub)
       SELECT n, n || '@loadtest.invalid', s, b FROM unnest($1::text[], $2::text[], $3::text[]) AS t(n, s, b)
       ON CONFLICT (name) DO UPDATE SET sign_pub = EXCLUDED.sign_pub, box_pub = EXCLUDED.box_pub`,
      [users.map((u) => u.name), users.map((u) => u.signPub), users.map((u) => u.boxPub)]
    );
    fs.writeFileSync(OUT, JSON.stringify(users.map(({ name, boxPub, seed }) => ({ name, boxPub, seed }))));
    console.log(`seeded ${count} accounts (${users[0].name} … ${users.at(-1)!.name}); keys in ${OUT}`);
  }
} finally {
  await db.end();
}
