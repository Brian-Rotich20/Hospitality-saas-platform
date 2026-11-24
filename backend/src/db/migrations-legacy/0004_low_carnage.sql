CREATE TYPE "public"."pricing_type" AS ENUM('per_hour', 'per_day', 'per_person', 'package', 'contact');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'paused', 'out_of_stock', 'deleted');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"icon" varchar(50),
	"image_url" text,
	"parent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_at" integer DEFAULT 5,
	"track_stock" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_inventory_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"price" numeric(10, 2),
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"category_id" uuid,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"price" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'KES' NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_photo" varchar(500),
	"whatsapp_message" text,
	"is_digital" boolean DEFAULT false NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DROP INDEX "listings_location_idx";--> statement-breakpoint
DROP INDEX "listings_category_idx";--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "location" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "views" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "bookings_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "full_name" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" varchar(500);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "slug" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "whatsapp_number" varchar(20);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "email" varchar(255);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "website" varchar(500);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "county" varchar(100);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "logo" varchar(500);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "cover_photo" varchar(500);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "category_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pricing_type" "pricing_type" DEFAULT 'per_day' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "min_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "max_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pricing_type" varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "currency" varchar(3) DEFAULT 'KES' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "inventory_product_idx" ON "product_inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_vendor_idx" ON "products" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendors_user_idx" ON "vendors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vendors_slug_idx" ON "vendors" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listings_category_idx" ON "listings" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "vendors" DROP COLUMN "business_type";--> statement-breakpoint
ALTER TABLE "vendors" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "county";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "city";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "capacity";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "base_price";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "amenities";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "instant_booking";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "min_booking_duration";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "max_booking_duration";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "lead_time";--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_slug_unique" UNIQUE("slug");--> statement-breakpoint
DROP TYPE "public"."business_type";--> statement-breakpoint
DROP TYPE "public"."listing_category";