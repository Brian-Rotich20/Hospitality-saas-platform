ALTER TYPE "public"."listing_category" ADD VALUE 'other';--> statement-breakpoint
ALTER TYPE "public"."booking_status" ADD VALUE 'declined' BEFORE 'disputed';--> statement-breakpoint
CREATE TABLE "availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"date" date NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_listing_date" UNIQUE("listing_id","date")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "slug" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "county" varchar(100);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "currency" varchar(3) DEFAULT 'KES' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "cover_photo" varchar(500);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "min_booking_duration" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "max_booking_duration" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "lead_time" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "views" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "bookings_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "responded_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_listing_date_idx" ON "availability" USING btree ("listing_id","date");--> statement-breakpoint
CREATE INDEX "listings_vendor_idx" ON "listings" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "listings_category_idx" ON "listings" USING btree ("category");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listings_location_idx" ON "listings" USING btree ("location");--> statement-breakpoint
CREATE INDEX "listings_slug_idx" ON "listings" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "bookings_listing_idx" ON "bookings" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_dates_idx" ON "bookings" USING btree ("start_date","end_date");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_slug_unique" UNIQUE("slug");