DROP INDEX "outbox_pending_idx";--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "requires_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "review_reason" varchar(100);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "delivered_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempts_review_idx" ON "payment_attempts" USING btree ("created_at") WHERE requires_review and reviewed_at is null;--> statement-breakpoint
CREATE INDEX "provider_events_unmatched_idx" ON "provider_events" USING btree ("received_at") WHERE attempt_id is null;--> statement-breakpoint
CREATE INDEX "provider_events_attempt_idx" ON "provider_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "outbox_failed_idx" ON "outbox" USING btree ("failed_at") WHERE failed_at is not null and processed_at is null;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE processed_at is null and failed_at is null;--> statement-breakpoint
-- Hand-written backfills (idempotent). Carry review states that 0001-era code recorded
-- only in free text / the revenue journal into the new explicit columns.
UPDATE "payment_attempts" SET "requires_review" = true, "review_reason" = 'amount_or_currency_mismatch'
  WHERE "requires_review" = false AND "failure_reason" = 'amount_or_currency_mismatch_requires_review';--> statement-breakpoint
UPDATE "payment_attempts" pa SET "requires_review" = true, "review_reason" = 'paid_settled_invoice'
  FROM "revenue_entries" re
  WHERE re."attempt_id" = pa."id" AND re."requires_review" AND pa."requires_review" = false;--> statement-breakpoint
-- Outbox rows that exhausted their retries under the old dispatcher (8 attempts) are dead letters.
UPDATE "outbox" SET "failed_at" = now() WHERE "processed_at" IS NULL AND "failed_at" IS NULL AND "attempts" >= 8;--> statement-breakpoint
-- Append-only history, enforced by the database: the audit trail, booking transitions and the
-- revenue journal can only be inserted. Corrections are new rows (e.g. reversal entries).
-- Row-level triggers do not fire on TRUNCATE; removing them is a reviewed contract migration.
CREATE OR REPLACE FUNCTION "linkmart_forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "linkmart_forbid_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "booking_events_append_only" ON "booking_events";--> statement-breakpoint
CREATE TRIGGER "booking_events_append_only" BEFORE UPDATE OR DELETE ON "booking_events" FOR EACH ROW EXECUTE FUNCTION "linkmart_forbid_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "revenue_entries_append_only" ON "revenue_entries";--> statement-breakpoint
CREATE TRIGGER "revenue_entries_append_only" BEFORE UPDATE OR DELETE ON "revenue_entries" FOR EACH ROW EXECUTE FUNCTION "linkmart_forbid_mutation"();