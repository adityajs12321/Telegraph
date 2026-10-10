-- Accounts are now tied to an email. Name-only registrations from before can't log in, so clear them
-- (and messages waiting for them); those devices sign up again with an email.
DELETE FROM "envelopes";--> statement-breakpoint
DELETE FROM "identities";--> statement-breakpoint
CREATE TABLE "login_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_email_unique" UNIQUE("email");