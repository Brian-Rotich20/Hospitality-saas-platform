// Listings. Public visibility = listing active AND vendor approved AND vendor subscription
// entitled. Owners see their own drafts and paused listings; deleted listings are never shown.
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, type Db } from '../../platform/database/client.js';
import { listings } from '../../platform/database/schema/listings.js';
import { categories } from '../../platform/database/schema/categories.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { cache } from '../../platform/cache/redis.js';
import { vendorEntitledSql } from '../subscriptions/service.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../app/errors.js';
import type { CreateListingInput, SearchListingsInput, UpdateListingInput } from './listings.schema.js';

export type ListingRow = typeof listings.$inferSelect;

const SELECT = sql.raw(`
  l.id, l.vendor_id AS "vendorId", l.category_id AS "categoryId", l.title, l.slug, l.description, l.location,
  l.pricing_type AS "pricingType", l.price, l.min_price AS "minPrice", l.max_price AS "maxPrice", l.currency,
  l.photos, l.cover_photo AS "coverPhoto", l.status, l.views, l.bookings_count AS "bookingsCount",
  l.rating::float8 AS rating, l.review_count AS "reviewCount", l.created_at AS "createdAt", l.updated_at AS "updatedAt",
  json_build_object('id', v.id, 'businessName', v.business_name, 'slug', v.slug, 'logo', v.logo,
                    'phoneNumber', v.phone_number, 'verified', v.verified) AS vendor,
  json_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'icon', c.icon, 'parentId', c.parent_id) AS category`);
const FROM = sql.raw(`FROM listings l JOIN vendors v ON v.id = l.vendor_id LEFT JOIN categories c ON c.id = l.category_id`);
const PUBLIC = sql.raw(`l.status = 'active' AND v.status = 'approved' AND `);
const publicWhere = (): SQL => sql`${PUBLIC}${vendorEntitledSql('v.id')}`;

/**
 * API contract for listing money and rating fields: prices are decimal strings
 * ("50000.00", exact; null when not set), rating is a number (one decimal) or null.
 */
type ListingView = Record<string, unknown> & {
  id: string; vendorId: string; status: string; slug: string; pricingType: string; currency: string;
  price: string | null; minPrice: string | null; maxPrice: string | null; rating: number | null; reviewCount: number;
};

/** Drizzle returns numeric columns as strings; the API returns rating as a number. */
function present<T extends { rating: string | null }>(row: T): Omit<T, 'rating'> & { rating: number | null } {
  return { ...row, rating: row.rating === null ? null : Number(row.rating) };
}

function slugify(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'listing';
  return `${base}-${Date.now().toString(36)}`;
}

function validatePricing(p: { pricingType?: string | undefined; price?: string | number | null | undefined; minPrice?: string | number | null | undefined; maxPrice?: string | number | null | undefined }) {
  if (p.pricingType === 'package') {
    if (p.minPrice == null || p.maxPrice == null) throw new ValidationError('Set a price range for package pricing');
    if (Number(p.minPrice) > Number(p.maxPrice)) throw new ValidationError('Minimum price cannot exceed maximum price');
  } else if (p.pricingType && p.pricingType !== 'contact' && p.price == null) {
    throw new ValidationError('Price is required for this pricing type');
  }
}

async function assertCategory(categoryId: string, tx: Db = db) {
  const cat = await tx.query.categories.findFirst({ where: eq(categories.id, categoryId), columns: { id: true } });
  if (!cat) throw new ValidationError('Invalid category');
}

async function ownedListing(listingId: string, vendorId: string, tx: Db = db): Promise<ListingRow> {
  const row = await tx.query.listings.findFirst({ where: eq(listings.id, listingId) });
  // Another vendor's listing looks exactly like a missing one (no ownership oracle).
  if (!row || row.vendorId !== vendorId || row.status === 'deleted') throw new NotFoundError('Listing');
  return row;
}

async function catalogKey(suffix: string): Promise<string> {
  // v2: rating became a number; never serve entries cached with the old string shape.
  return `catalog:v2:${await cache.version('catalog')}:${suffix}`;
}

export const listingsService = {
  async create(vendorId: string, data: CreateListingInput) {
    await assertCategory(data.categoryId);
    validatePricing(data);
    const [row] = await db.insert(listings).values({
      vendorId,
      categoryId: data.categoryId,
      title: data.title,
      slug: slugify(data.title),
      description: data.description,
      location: data.location,
      pricingType: data.pricingType,
      price: data.price?.toString(),
      minPrice: data.minPrice?.toString(),
      maxPrice: data.maxPrice?.toString(),
      currency: data.currency,
      photos: data.photos,
      coverPhoto: data.coverPhoto ?? data.photos[0],
      status: 'draft',
    }).returning();
    if (!row) throw new Error('listing insert returned no row');
    return present(row);
  },

  async update(listingId: string, vendorId: string, data: UpdateListingInput) {
    const current = await ownedListing(listingId, vendorId);
    if (data.categoryId) await assertCategory(data.categoryId);
    const merged = {
      pricingType: data.pricingType ?? current.pricingType,
      price: data.price ?? current.price,
      minPrice: data.minPrice ?? current.minPrice,
      maxPrice: data.maxPrice ?? current.maxPrice,
    };
    validatePricing(merged);
    // Slugs are stable: renaming must not break links already shared.
    const [row] = await db.update(listings).set({
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.photos !== undefined && { photos: data.photos }),
      ...(data.coverPhoto !== undefined && { coverPhoto: data.coverPhoto }),
      ...(data.pricingType !== undefined && { pricingType: data.pricingType }),
      ...(data.price !== undefined && { price: data.price.toString() }),
      ...(data.minPrice !== undefined && { minPrice: data.minPrice.toString() }),
      ...(data.maxPrice !== undefined && { maxPrice: data.maxPrice.toString() }),
      ...(data.currency !== undefined && { currency: data.currency }),
      updatedAt: new Date(),
    }).where(eq(listings.id, listingId)).returning();
    await cache.bump('catalog');
    if (!row) throw new NotFoundError('Listing');
    return present(row);
  },

  /** Publishing requires an entitled subscription; the caller passes the vendor's entitlement. */
  async setStatus(listingId: string, vendorId: string, status: 'active' | 'paused', entitled: boolean) {
    const current = await ownedListing(listingId, vendorId);
    if (status === 'active') {
      if (!entitled) throw new ForbiddenError('Your subscription is not active. Pay the outstanding invoice to publish listings.', 'SUBSCRIPTION_INACTIVE');
      if ((current.photos ?? []).length < 3) throw new ValidationError('Add at least 3 photos before publishing');
      validatePricing(current);
    }
    if (current.status === status) return present(current);
    const [row] = await db.update(listings).set({ status, updatedAt: new Date() }).where(and(eq(listings.id, listingId), eq(listings.vendorId, vendorId))).returning();
    await cache.bump('catalog');
    if (!row) throw new NotFoundError('Listing');
    return present(row);
  },

  async remove(listingId: string, vendorId: string) {
    await ownedListing(listingId, vendorId);
    // Accepted, upcoming bookings must be cancelled first so customers are informed.
    const upcoming = await db.execute(sql`SELECT 1 FROM bookings WHERE listing_id = ${listingId} AND lifecycle_status IN ('requested','accepted') AND end_date >= now()::date LIMIT 1`);
    if ((upcoming as unknown[]).length > 0) throw new ConflictError('This listing has open or upcoming bookings. Resolve them before deleting it.', 'LISTING_HAS_BOOKINGS');
    await db.update(listings).set({ status: 'deleted', updatedAt: new Date() }).where(eq(listings.id, listingId));
    await cache.bump('catalog');
  },

  /** Public detail. `viewerVendorId` lets an owner load their own non-public listing. */
  async getById(listingId: string, viewerVendorId?: string) {
    const key = await catalogKey(`listing:${listingId}`);
    const cached = await cache.get<ListingView>(key);
    if (cached) return cached;
    const rows = await db.execute(sql`SELECT ${SELECT} ${FROM} WHERE l.id = ${listingId} AND l.status <> 'deleted' LIMIT 1`) as unknown as ListingView[];
    const row = rows[0];
    if (!row) throw new NotFoundError('Listing');
    const isOwner = viewerVendorId !== undefined && row.vendorId === viewerVendorId;
    if (!isOwner) {
      const visible = await db.execute(sql`SELECT 1 ${FROM} WHERE l.id = ${listingId} AND ${publicWhere()}`) as unknown[];
      if (visible.length === 0) throw new NotFoundError('Listing');
      await cache.set(key, row, 600);
      db.execute(sql`UPDATE listings SET views = views + 1 WHERE id = ${listingId}`).catch(() => undefined);
    }
    return row;
  },

  async getBySlug(slug: string) {
    const key = await catalogKey(`slug:${slug}`);
    const cached = await cache.get<ListingView>(key);
    if (cached) return cached;
    const rows = await db.execute(sql`SELECT ${SELECT} ${FROM} WHERE l.slug = ${slug} AND ${publicWhere()} LIMIT 1`) as unknown as ListingView[];
    const row = rows[0];
    if (!row) throw new NotFoundError('Listing');
    await cache.set(key, row, 600);
    db.execute(sql`UPDATE listings SET views = views + 1 WHERE id = ${row.id}`).catch(() => undefined);
    return row;
  },

  async search(f: SearchListingsInput) {
    const key = await catalogKey(`search:${JSON.stringify(f)}`);
    const cached = await cache.get<{ items: ListingView[]; total: number }>(key);
    if (cached) return cached;

    const conds: SQL[] = [publicWhere()];
    if (f.categoryId) conds.push(sql`(l.category_id = ${f.categoryId} OR c.parent_id = ${f.categoryId})`);
    else if (f.categorySlug) conds.push(sql`(c.slug = ${f.categorySlug} OR EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id AND p.slug = ${f.categorySlug}))`);
    if (f.county) conds.push(sql`l.location->>'county' ILIKE ${`%${f.county}%`}`);
    if (f.area) conds.push(sql`l.location->>'area' ILIKE ${`%${f.area}%`}`);
    if (f.minPrice != null) conds.push(sql`coalesce(l.price, l.max_price) >= ${f.minPrice}`);
    if (f.maxPrice != null) conds.push(sql`coalesce(l.price, l.min_price) <= ${f.maxPrice}`);
    if (f.search) {
      const term = `%${f.search}%`;
      conds.push(sql`(l.title ILIKE ${term} OR l.description ILIKE ${term} OR l.location->>'county' ILIKE ${term} OR l.location->>'area' ILIKE ${term})`);
    }
    if (f.vendorId) conds.push(sql`l.vendor_id = ${f.vendorId}`);
    const where = sql.join(conds, sql` AND `);
    const order = f.sortBy === 'price' ? sql`coalesce(l.price, l.min_price) ASC NULLS LAST, l.id`
      : f.sortBy === 'popular' ? sql`l.bookings_count DESC, l.views DESC, l.id` : sql`l.created_at DESC, l.id`;

    const items = await db.execute(sql`SELECT ${SELECT} ${FROM} WHERE ${where} ORDER BY ${order} LIMIT ${f.limit} OFFSET ${f.offset}`) as unknown as ListingView[];
    const countRows = await db.execute(sql`SELECT count(*)::int AS n ${FROM} WHERE ${where}`) as unknown as { n: number }[];
    const result = { items: [...items], total: countRows[0]?.n ?? 0 };
    await cache.set(key, result, 120);
    return result;
  },

  async featured(limit = 10) {
    const key = await catalogKey(`featured:${limit}`);
    const cached = await cache.get<ListingView[]>(key);
    if (cached) return cached;
    const rows = await db.execute(sql`SELECT ${SELECT} ${FROM} WHERE ${publicWhere()} ORDER BY l.bookings_count DESC, l.views DESC, l.id LIMIT ${limit}`) as unknown as ListingView[];
    const out = [...rows];
    await cache.set(key, out, 600);
    return out;
  },

  async mine(vendorId: string) {
    const rows = await db.execute(sql`SELECT ${SELECT} ${FROM} WHERE l.vendor_id = ${vendorId} AND l.status <> 'deleted' ORDER BY l.updated_at DESC`) as unknown as ListingView[];
    return [...rows];
  },

  /**
   * Booking-time check: listing exists and is publicly bookable (active, vendor approved,
   * subscription entitled). Locks the listing row so request/accept/block operations on
   * the same listing serialise.
   */
  async lockBookable(listingId: string, tx: Db) {
    const [row] = await tx.select({
      id: listings.id, vendorId: listings.vendorId, title: listings.title,
      pricingType: listings.pricingType, currency: listings.currency, vendorUserId: vendors.userId,
    }).from(listings).innerJoin(vendors, eq(vendors.id, listings.vendorId))
      .where(and(eq(listings.id, listingId), eq(listings.status, 'active'), eq(vendors.status, 'approved'), vendorEntitledSql('"vendors"."id"')))
      .for('update', { of: listings });
    if (!row) throw new NotFoundError('Listing');
    return row;
  },

  /** Lock a listing owned by `vendorId` (availability changes, acceptance). */
  async lockOwned(listingId: string, vendorId: string, tx: Db) {
    const [row] = await tx.select({ id: listings.id, vendorId: listings.vendorId, status: listings.status, title: listings.title })
      .from(listings).where(and(eq(listings.id, listingId), eq(listings.vendorId, vendorId))).for('update');
    if (!row || row.status === 'deleted') throw new NotFoundError('Listing');
    return row;
  },
};
