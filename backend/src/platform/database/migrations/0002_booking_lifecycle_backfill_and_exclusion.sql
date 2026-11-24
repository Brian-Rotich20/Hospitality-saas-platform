-- Booking lifecycle backfill + double-booking protection.
-- Additive only: the legacy "status" column and its values are preserved untouched.

-- 1. Map legacy statuses onto the new lifecycle. Legacy "confirmed" implied a verified
--    payment; under the connection-platform model it is equivalent to "accepted".
--    Legacy "disputed" has no equivalent and is recorded as cancelled by the system;
--    the original value remains in the legacy "status" column.
UPDATE "bookings" SET
  "lifecycle_status" = CASE "status"
    WHEN 'pending'   THEN 'requested'::booking_lifecycle_status
    WHEN 'confirmed' THEN 'accepted'::booking_lifecycle_status
    WHEN 'completed' THEN 'completed'::booking_lifecycle_status
    WHEN 'cancelled' THEN 'cancelled'::booking_lifecycle_status
    WHEN 'declined'  THEN 'declined'::booking_lifecycle_status
    WHEN 'disputed'  THEN 'cancelled'::booking_lifecycle_status
    ELSE "lifecycle_status"
  END,
  "cancelled_by" = CASE WHEN "status" = 'disputed' THEN 'system'::booking_actor ELSE "cancelled_by" END,
  "cancellation_reason" = CASE WHEN "status" = 'disputed' THEN coalesce("cancellation_reason", 'Legacy status: disputed') ELSE "cancellation_reason" END
WHERE "status" IS NOT NULL;
--> statement-breakpoint

-- 2. Every open request gets a response deadline derived from when it was created.
UPDATE "bookings"
SET "respond_by" = ("created_at" AT TIME ZONE 'UTC') + interval '24 hours'
WHERE "lifecycle_status" = 'requested' AND "respond_by" IS NULL;
--> statement-breakpoint

-- 3. Fail loudly (aborting the whole migration) if legacy data already contains
--    overlapping accepted bookings, instead of letting the constraint error be cryptic.
DO $$
DECLARE overlap_count integer;
BEGIN
  SELECT count(*) INTO overlap_count
  FROM "bookings" a JOIN "bookings" b
    ON a."listing_id" = b."listing_id" AND a."id" < b."id"
   AND a."lifecycle_status" = 'accepted' AND b."lifecycle_status" = 'accepted'
   AND a."period" && b."period";
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'Cannot add booking exclusion constraint: % overlapping accepted booking pair(s). Resolve them first.', overlap_count;
  END IF;
END $$;
--> statement-breakpoint

-- 4. No two accepted bookings for the same listing may overlap, enforced by the database
--    regardless of application code or concurrency.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlapping_accepted"
  EXCLUDE USING gist ("listing_id" WITH =, "period" WITH &&) WHERE ("lifecycle_status" = 'accepted');
--> statement-breakpoint

-- 5. Data integrity checks for new columns.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dates_order" CHECK ("end_date" >= "start_date") NOT VALID;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guests_positive" CHECK ("guests" > 0) NOT VALID;
