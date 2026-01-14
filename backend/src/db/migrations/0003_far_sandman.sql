CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"booking_id" uuid,
	"gross_amount" numeric(10, 2) NOT NULL,
	"platform_fee" numeric(10, 2) NOT NULL,
	"vat" numeric(10, 2) NOT NULL,
	"withholding_tax" numeric(10, 2) NOT NULL,
	"net_amount" numeric(10, 2) NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"payout_method" varchar(20) NOT NULL,
	"account_details" varchar(255) NOT NULL,
	"gateway_reference" varchar(255),
	"gateway_response" text,
	"failure_reason" text,
	"retry_count" varchar(10) DEFAULT '0',
	"scheduled_at" timestamp,
	"processed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_vendor_idx" ON "payouts" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payouts_scheduled_idx" ON "payouts" USING btree ("scheduled_at");