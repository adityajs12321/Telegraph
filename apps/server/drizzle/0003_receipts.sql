CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_receipts_sender" ON "receipts" USING btree ("sender");