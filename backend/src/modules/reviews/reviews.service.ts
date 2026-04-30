// src/modules/reviews/reviews.service.ts
import { eq, and, avg, count, sql } from 'drizzle-orm';
import { db }      from '../../config/database';
import { reviews } from '../../db/schema/reviews';
import { bookings } from '../../db/schema/bookings';
import { listings } from '../../db/schema/listings';
import { vendors }  from '../../db/schema/vendors';
import { delCache } from '../../config/redis';
import type { CreateReviewInput, VendorReplyInput } from './reviews.schema';

export class ReviewService {

  // ── Create — gated by completed booking ──────────────────────────────────

  async createReview(customerId: string, data: CreateReviewInput) {
    // 1. Verify booking exists, belongs to customer, and is completed
    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id,         data.bookingId),
        eq(bookings.customerId, customerId),
        eq(bookings.status,     'completed'),
      ),
      with: { listing: { columns: { id: true, vendorId: true } } },
    });

    if (!booking)        throw new Error('Booking not found or not eligible for review');
    if (!booking.listing) throw new Error('Listing not found');

    // 2. Check no review already exists for this booking
    const existing = await db.query.reviews.findFirst({
      where: eq(reviews.bookingId, data.bookingId),
    });
    if (existing) throw new Error('You have already reviewed this booking');

    // 3. Insert review
    const [review] = await db.insert(reviews).values({
      bookingId:  data.bookingId,
      listingId:  booking.listing.id,
      vendorId:   booking.listing.vendorId,
      customerId,
      rating:     data.rating,
      title:      data.title,
      body:       data.body,
    }).returning();

    // 4. Update listing avg rating + review count (denormalized for fast reads)
    await this._updateListingRating(booking.listing.id);

    // 5. Bust listing cache
    await delCache(`listing:${booking.listing.id}`);

    return review;
  }

  // ── Get reviews for a listing (public) ────────────────────────────────────

  async getListingReviews(listingId: string, limit = 20, offset = 0) {
    return db.query.reviews.findMany({
      where: and(
        eq(reviews.listingId,  listingId),
        eq(reviews.isVisible,  true),
      ),
      with: {
        customer: {
          columns: { id: true, fullName: true },
        },
      },
      orderBy: (r, { desc }) => [desc(r.createdAt)],
      limit,
      offset,
    });
  }

  // ── Get review stats for a listing (avg + breakdown) ──────────────────────

  async getListingReviewStats(listingId: string) {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int                                       AS total,
        ROUND(AVG(rating)::numeric, 1)                     AS average,
        COUNT(*) FILTER (WHERE rating = 5)::int            AS five,
        COUNT(*) FILTER (WHERE rating = 4)::int            AS four,
        COUNT(*) FILTER (WHERE rating = 3)::int            AS three,
        COUNT(*) FILTER (WHERE rating = 2)::int            AS two,
        COUNT(*) FILTER (WHERE rating = 1)::int            AS one
      FROM reviews
      WHERE listing_id = ${listingId}
        AND is_visible  = true
    `);
    return (rows as any[])[0] ?? { total: 0, average: 0, five: 0, four: 0, three: 0, two: 0, one: 0 };
  }

  // ── Check if customer can review a listing ─────────────────────────────────
  // Returns { canReview, bookingId | null, reason }

  async getReviewEligibility(customerId: string, listingId: string) {
    // Find completed bookings for this listing by this customer
    const completedBooking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.customerId, customerId),
        eq(bookings.listingId,  listingId),
        eq(bookings.status,     'completed'),
      ),
      orderBy: (b, { desc }) => [desc(b.completedAt)],
    });

    if (!completedBooking) {
      return { canReview: false, bookingId: null, reason: 'No completed booking for this listing' };
    }

    // Check if already reviewed
    const existing = await db.query.reviews.findFirst({
      where: eq(reviews.bookingId, completedBooking.id),
    });

    if (existing) {
      return { canReview: false, bookingId: completedBooking.id, reason: 'Already reviewed', existingReviewId: existing.id };
    }

    return { canReview: true, bookingId: completedBooking.id, reason: null };
  }

  // ── Vendor reply ──────────────────────────────────────────────────────────

  async addVendorReply(reviewId: string, vendorId: string, data: VendorReplyInput) {
    const review = await db.query.reviews.findFirst({
      where: eq(reviews.id, reviewId),
    });
    if (!review)                      throw new Error('Review not found');
    if (review.vendorId !== vendorId) throw new Error('Unauthorized');
    if (review.vendorReply)           throw new Error('Reply already posted');

    const [updated] = await db.update(reviews)
      .set({ vendorReply: data.reply, vendorRepliedAt: new Date(), updatedAt: new Date() })
      .where(eq(reviews.id, reviewId))
      .returning();

    return updated;
  }

  // ── Admin: hide/show review ────────────────────────────────────────────────

  async setVisibility(reviewId: string, isVisible: boolean) {
    const [updated] = await db.update(reviews)
      .set({ isVisible, updatedAt: new Date() })
      .where(eq(reviews.id, reviewId))
      .returning();

    if (updated) await this._updateListingRating(updated.listingId);
    return updated;
  }

  // ── Internal: recalculate + persist avg rating on listings table ──────────

  private async _updateListingRating(listingId: string) {
    const stats = await this.getListingReviewStats(listingId);
    // listings table needs rating + reviewCount columns — see migration note
    await db.execute(sql`
      UPDATE listings
      SET    rating       = ${stats.average},
             review_count = ${stats.total},
             updated_at   = NOW()
      WHERE  id           = ${listingId}
    `);
  }
}