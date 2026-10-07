CREATE TABLE "envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"sender" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"name" text PRIMARY KEY NOT NULL,
	"sign_pub" text NOT NULL,
	"box_pub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_envelopes_recipient" ON "envelopes" USING btree ("recipient","created_at");