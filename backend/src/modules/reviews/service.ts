// Reviews: one per completed booking (DB-unique), customer-authored; one vendor reply;
// admin visibility moderation. Listing rating is recomputed in the same transaction.
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import { reviews } from '../../platform/database/schema/reviews.js';
import { bookings } from '../../platform/database/schema/bookings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { cache } from '../../platform/cache/redis.js';
import { recordAudit } from '../../app/audit.js';
import { ConflictError, NotFoundError } from '../../app/errors.js';

interface Stats { total: number; average: string | null; five: number; four: number; three: number; two: number; one: number }

async function stats(listingId: string, tx: Db = db): Promise<Stats> {
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS total, round(avg(rating)::numeric, 1)::text AS average,
      count(*) FILTER (WHERE rating = 5)::int AS five, count(*) FILTER (WHERE rating = 4)::int AS four,
      count(*) FILTER (WHERE rating = 3)::int AS three, count(*) FILTER (WHERE rating = 2)::int AS two,
      count(*) FILTER (WHERE rating = 1)::int AS one
    FROM reviews WHERE listing_id = ${listingId} AND is_visible = true`) as unknown as Stats[];
  return rows[0] ?? { total: 0, average: null, five: 0, four: 0, three: 0, two: 0, one: 0 };
}

async function refreshRating(listingId: string, tx: Db) {
  const s = await stats(listingId, tx);
  await tx.update(listings).set({ rating: s.average, reviewCount: s.total, updatedAt: new Date() }).where(eq(listings.id, listingId));
}

export const reviewsService = {
  async create(customerId: string, input: { bookingId: string; rating: number; title?: string | undefined; body: string }) {
    const review = await withTransaction(async (tx) => {
      const [b] = await tx.select({ id: bookings.id, listingId: bookings.listingId, vendorId: listings.vendorId }).from(bookings)
        .innerJoin(listings, eq(listings.id, bookings.listingId))
        .where(and(eq(bookings.id, input.bookingId), eq(bookings.customerId, customerId), eq(bookings.status, 'completed')));
      if (!b) throw new NotFoundError('Completed booking');
      const [row] = await tx.insert(reviews).values({
        bookingId: b.id, listingId: b.listingId, vendorId: b.vendorId, customerId, rating: input.rating, title: input.title ?? null, body: input.body,
      }).onConflictDoNothing({ target: reviews.bookingId }).returning();
      if (!row) throw new ConflictError('You have already reviewed this booking', 'ALREADY_REVIEWED');
      await refreshRating(b.listingId, tx);
      return row;
    });
    await cache.bump('catalog');
    return review;
  },

  async forListing(listingId: string, limit: number, offset: number) {
    const items = await db.query.reviews.findMany({
      where: and(eq(reviews.listingId, listingId), eq(reviews.isVisible, true)),
      with: { customer: { columns: { id: true, fullName: true } } },
      orderBy: [desc(reviews.createdAt)], limit, offset,
    });
    const s = await stats(listingId);
    // API contract: average is a number (one decimal) or null, never a string.
    return { reviews: items, stats: { ...s, average: s.average === null ? null : Number(s.average) } };
  },

  async eligibility(customerId: string, listingId: string) {
    const rows = await db.execute(sql`
      SELECT b.id, r.id AS review_id FROM bookings b LEFT JOIN reviews r ON r.booking_id = b.id
      WHERE b.customer_id = ${customerId} AND b.listing_id = ${listingId} AND b.lifecycle_status = 'completed'
      ORDER BY (r.id IS NULL) DESC, b.completed_at DESC LIMIT 1`) as unknown as { id: string; review_id: string | null }[];
    const r = rows[0];
    if (!r) return { canReview: false, bookingId: null, reason: 'No completed booking for this listing' };
    if (r.review_id) return { canReview: false, bookingId: r.id, reason: 'Already reviewed', existingReviewId: r.review_id };
    return { canReview: true, bookingId: r.id, reason: null };
  },

  async reply(reviewId: string, vendorId: string, text: string) {
    const [row] = await db.update(reviews).set({ vendorReply: text, vendorRepliedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(reviews.id, reviewId), eq(reviews.vendorId, vendorId), sql`${reviews.vendorReply} IS NULL`)).returning();
    if (row) return row;
    const exists = await db.query.reviews.findFirst({ where: and(eq(reviews.id, reviewId), eq(reviews.vendorId, vendorId)), columns: { id: true } });
    if (!exists) throw new NotFoundError('Review');
    throw new ConflictError('A reply has already been posted', 'ALREADY_REPLIED');
  },

  async setVisibility(reviewId: string, isVisible: boolean, adminUserId: string, requestId?: string) {
    const row = await withTransaction(async (tx) => {
      const [r] = await tx.update(reviews).set({ isVisible, updatedAt: new Date() }).where(eq(reviews.id, reviewId)).returning();
      if (!r) throw new NotFoundError('Review');
      await refreshRating(r.listingId, tx);
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: isVisible ? 'review.shown' : 'review.hidden', entityType: 'review', entityId: reviewId, requestId }, tx);
      return r;
    });
    await cache.bump('catalog');
    return row;
  },
};
