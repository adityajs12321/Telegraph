// Database tables.

import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Envelope } from "@telegraph/shared";

export const identities = pgTable("identities", {
  name: text("name").primaryKey(),
  email: text("email").notNull().unique(),
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

// login codes dispatched to the user
export const loginCodes = pgTable("login_codes", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
