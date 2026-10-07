// Database tables. After changing this file, run `npm run db:generate -w @telegraph/server`
// to create a migration; migrations are applied on server startup.
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Envelope } from "@telegraph/shared";

export const identities = pgTable("identities", {
  name: text("name").primaryKey(),
  signPub: text("sign_pub").notNull(),
  boxPub: text("box_pub").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const envelopes = pgTable(
  "envelopes",
  {
    id: text("id").primaryKey(),
    recipient: text("recipient").notNull(),
    sender: text("sender").notNull(),
    payload: jsonb("payload").$type<Envelope>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_envelopes_recipient").on(t.recipient, t.createdAt)]
);
