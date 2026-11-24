CREATE TYPE "public"."booking_actor" AS ENUM('customer', 'vendor', 'system', 'admin');--> statement-breakpoint
CREATE TYPE "public"."booking_lifecycle_status" AS ENUM('requested', 'accepted', 'declined', 'expired', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."subscription_invoice_status" AS ENUM('open', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('initiated', 'pending', 'succeeded', 'failed', 'reversed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('paystack', 'daraja');--> statement-breakpoint
CREATE TYPE "public"."revenue_entry_type" AS ENUM('subscription_payment', 'reversal', 'refund');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" "booking_lifecycle_status",
	"to_status" "booking_lifecycle_status" NOT NULL,
	"actor" "booking_actor" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'initiated' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"provider_reference" varchar(100),
	"provider_secondary_reference" varchar(100),
	"provider_receipt" varchar(100),
	"phone_masked" varchar(20),
	"checkout_url" text,
	"failure_reason" text,
	"provider_metadata" jsonb,
	"initiated_by" varchar(20) DEFAULT 'vendor' NOT NULL,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"event_key" varchar(200) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "revenue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" "revenue_entry_type" NOT NULL,
	"vendor_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_reference" varchar(100),
	"requires_review" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_entries_sign" CHECK (("revenue_entries"."entry_type" = 'subscription_payment' and "revenue_entries"."amount_minor" > 0) or ("revenue_entries"."entry_type" <> 'subscription_payment' and "revenue_entries"."amount_minor" < 0))
);
--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "subscription_invoice_status" DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by_attempt_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_amount_positive" CHECK ("subscription_invoices"."amount_minor" > 0),
	CONSTRAINT "subscription_invoices_period_order" CHECK ("subscription_invoices"."period_end" > "subscription_invoices"."period_start")
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"interval" varchar(10) DEFAULT 'month' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "subscription_plans_amount_positive" CHECK ("subscription_plans"."amount_minor" > 0),
	CONSTRAINT "subscription_plans_interval_month" CHECK ("subscription_plans"."interval" = 'month')
);
--> statement-breakpoint
CREATE TABLE "vendor_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"plan_id" uuid,
	"trial_started_at" timestamp with time zone NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"billing_hold_reason" varchar(50),
	"auto_renew_opt_in" boolean DEFAULT false NOT NULL,
	"paystack_authorization_code" text,
	"paystack_customer_email" varchar(255),
	"origin" varchar(30) DEFAULT 'onboarding' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_subscriptions_trial_order" CHECK ("vendor_subscriptions"."trial_ends_at" > "vendor_subscriptions"."trial_started_at")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_body_length" CHECK (char_length("messages"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_type" varchar(20) NOT NULL,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"details" jsonb,
	"request_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" varchar(200),
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"public_id" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"bytes" bigint NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "base_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "platform_fee" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "vat" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "total_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "lifecycle_status" "booking_lifecycle_status" DEFAULT 'requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "period" daterange GENERATED ALWAYS AS (daterange((start_date)::date, (end_date)::date, '[]')) STORED;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by" "booking_actor";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_invoice_id_subscription_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."subscription_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_invoice_id_subscription_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."subscription_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscription_id_vendor_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."vendor_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_idempotency_unique" ON "payment_attempts" USING btree ("vendor_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_ref_unique" ON "payment_attempts" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "payment_attempts_invoice_idx" ON "payment_attempts" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_pending_idx" ON "payment_attempts" USING btree ("status","created_at") WHERE status in ('initiated','pending');--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_key_unique" ON "provider_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE INDEX "provider_events_unprocessed_idx" ON "provider_events" USING btree ("received_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_entries_attempt_type_unique" ON "revenue_entries" USING btree ("attempt_id","entry_type");--> statement-breakpoint
CREATE INDEX "revenue_entries_occurred_idx" ON "revenue_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoices_period_unique" ON "subscription_invoices" USING btree ("subscription_id","period_start");--> statement-breakpoint
CREATE INDEX "subscription_invoices_vendor_idx" ON "subscription_invoices" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_invoices_open_idx" ON "subscription_invoices" USING btree ("status") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_one_active" ON "subscription_plans" USING btree ("is_active") WHERE is_active;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_subscriptions_vendor_unique" ON "vendor_subscriptions" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_subscriptions_status_idx" ON "vendor_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_booking_unique" ON "conversations" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "conversations_customer_idx" ON "conversations" USING btree ("customer_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_vendor_idx" ON "conversations" USING btree ("vendor_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reports_unique" ON "message_reports" USING btree ("message_id","reporter_id");--> statement-breakpoint
CREATE INDEX "message_reports_open_idx" ON "message_reports" USING btree ("created_at") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_unique" ON "outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_public_id_unique" ON "uploads" USING btree ("provider","public_id");--> statement-breakpoint
CREATE INDEX "uploads_owner_idx" ON "uploads" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_listing_lifecycle_idx" ON "bookings" USING btree ("listing_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "bookings_customer_lifecycle_idx" ON "bookings" USING btree ("customer_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "bookings_requested_respond_by_idx" ON "bookings" USING btree ("respond_by") WHERE lifecycle_status = 'requested';