ALTER TABLE "payments" ADD COLUMN "currency" varchar(3) DEFAULT 'KES' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gateway_reference" varchar(255);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "retry_count" varchar(10) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_transaction_idx" ON "payments" USING btree ("transaction_id");