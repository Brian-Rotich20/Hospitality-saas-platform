import { eq, sql } from 'drizzle-orm';
import { db }       from '../../config/database';
import { listings, vendors, categories } from '../../db/schema';
import { setCache, getCache, delCache }  from '../../config/redis';
import type { ListingFilters }           from './listings.types';
import type { CreateListingInput, UpdateListingInput } from './listings.schema';

const LISTING_SELECT = `
  l.id, l.vendor_id, l.category_id, l.title, l.slug, l.description,
  l.location, l.pricing_type, l.price, l.min_price, l.max_price,
  l.currency, l.photos, l.cover_photo,
  l.status, l.views, l.bookings_count, l.created_at, l.updated_at, l.rating, l.reviews_count,
  json_build_object(
    'id',             v.id,
    'businessName',   v.business_name,
    'slug',           v.slug,
    'logo',           v.logo,
    'whatsappNumber', v.whatsapp_number,
    'phoneNumber',    v.phone_number,
    'verified',       v.verified
  ) as vendor,
  json_build_object(
    'id',         c.id,
    'name',       c.name,
    'slug',       c.slug,
    'icon',       c.icon,
    'parentId',   c.parent_id
  ) as category
`;

const LISTING_JOINS = `
  FROM listings l
  LEFT JOIN vendors    v ON v.id = l.vendor_id
  LEFT JOIN categories c ON c.id = l.category_id
`;

export class ListingService {

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + Date.now();
  }

  private async getApprovedVendor(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor)                        throw new Error('Vendor not found');
    if (vendor.status !== 'approved')   throw new Error('Only approved vendors can manage listings');
    return vendor;
  }

  // ── Create ────────────────────────────────────────────────────────────────────
  async createListing(vendorId: string, data: CreateListingInput) {
    await this.getApprovedVendor(vendorId);

    const category = await db.query.categories.findFirst({
      where: eq(categories.id, data.categoryId),
    });
    if (!category) throw new Error('Invalid category');

    const slug       = this.generateSlug(data.title);
    const coverPhoto = data.coverPhoto ?? data.photos?.[0];

    const [listing] = await db.insert(listings).values({
      vendorId,
      categoryId:  data.categoryId,
      title:       data.title,
      slug,
      description: data.description,
      location:    data.location,
      pricingType: data.pricingType,
      price:       data.price?.toString(),
      minPrice:    data.minPrice?.toString(),
      maxPrice:    data.maxPrice?.toString(),
      currency:    data.currency ?? 'KES',
      photos:      data.photos   ?? [],
      coverPhoto,
      status:      'draft',
    }).returning();

    return listing;
  }

  // ── Get by ID ─────────────────────────────────────────────────────────────────
  async getListingById(listingId: string) {
    const cacheKey = `listing:${listingId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const rows = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE l.id = ${listingId}
      LIMIT 1
    `);

    const listing = (rows as any[])[0];
    if (!listing) throw new Error('Listing not found');

    db.execute(sql`UPDATE listings SET views = views + 1 WHERE id = ${listingId}`)
      .catch(() => {});

    await setCache(cacheKey, listing, 600);
    return listing;
  }

  // ── Get by slug ───────────────────────────────────────────────────────────────
  async getListingBySlug(slug: string) {
    const cacheKey = `listing:slug:${slug}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const rows = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE l.slug = ${slug}
        AND l.status != 'deleted'
      LIMIT 1
    `);

    const listing = (rows as any[])[0];
    if (!listing) throw new Error('Listing not found');

    db.execute(sql`UPDATE listings SET views = views + 1 WHERE id = ${listing.id}`)
      .catch(() => {});

    await setCache(cacheKey, listing, 600);
    return listing;
  }

  // ── Update ────────────────────────────────────────────────────────────────────
  async updateListing(listingId: string, vendorId: string, data: UpdateListingInput) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });
    if (!listing)                      throw new Error('Listing not found');
    if (listing.vendorId !== vendorId) throw new Error('Unauthorized');

    if (data.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, data.categoryId),
      });
      if (!cat) throw new Error('Invalid category');
    }

    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (data.title) {
      updateData.title = data.title;
      updateData.slug  = this.generateSlug(data.title);
    }
    if (data.description  != null) updateData.description  = data.description;
    if (data.categoryId   != null) updateData.categoryId   = data.categoryId;
    if (data.location     != null) updateData.location     = data.location;
    if (data.photos       != null) updateData.photos       = data.photos;
    if (data.coverPhoto   != null) updateData.coverPhoto   = data.coverPhoto;
    if (data.pricingType  != null) updateData.pricingType  = data.pricingType;
    if (data.price        != null) updateData.price        = data.price.toString();
    if (data.minPrice     != null) updateData.minPrice     = data.minPrice.toString();
    if (data.maxPrice     != null) updateData.maxPrice     = data.maxPrice.toString();
    if (data.currency     != null) updateData.currency     = data.currency;

    const [updated] = await db.update(listings)
      .set(updateData)
      .where(eq(listings.id, listingId))
      .returning();

    await delCache(`listing:${listingId}`);
    await delCache(`listing:slug:${listing.slug}`);
    return updated;
  }

  // ── Status ────────────────────────────────────────────────────────────────────
  async updateListingStatus(listingId: string, vendorId: string, status: 'active' | 'paused') {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });
    if (!listing)                      throw new Error('Listing not found');
    if (listing.vendorId !== vendorId) throw new Error('Unauthorized');

    if (status === 'active') {
      // ✅ Min 3 photos to publish
      if (!listing.photos || (listing.photos as string[]).length < 3)
        throw new Error('Add at least 3 photos before publishing');

      if (listing.pricingType === 'package') {
        if (!listing.minPrice && !listing.maxPrice)
          throw new Error('Set a price range before publishing');
      } else if (listing.pricingType !== 'contact') {
        if (!listing.price)
          throw new Error('Set a price before publishing');
      }
    }

    const [updated] = await db.update(listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(listings.id, listingId))
      .returning();

    await delCache(`listing:${listingId}`);
    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async deleteListing(listingId: string, vendorId: string) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });
    if (!listing)                      throw new Error('Listing not found');
    if (listing.vendorId !== vendorId) throw new Error('Unauthorized');

    const [deleted] = await db.update(listings)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(eq(listings.id, listingId))
      .returning();

    await delCache(`listing:${listingId}`);
    await delCache(`listing:slug:${listing.slug}`);
    return deleted;
  }

  // ── Search (public) ───────────────────────────────────────────────────────────
  async searchListings(filters: ListingFilters) {
    const cacheKey = `listings:search:${JSON.stringify(filters)}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const conditions = [sql`l.status = 'active'`];

    if (filters.categoryId) {
      // Match exact category OR any listing whose category's parent is this id
      conditions.push(sql`
        (l.category_id = ${filters.categoryId}
        OR EXISTS (
          SELECT 1 FROM categories sub
          WHERE sub.id = l.category_id
            AND sub.parent_id = ${filters.categoryId}
        ))
      `);
    } else if (filters.categorySlug) {
      conditions.push(sql`
        EXISTS (
          SELECT 1 FROM categories c2
          WHERE c2.id = l.category_id
            AND (c2.slug = ${filters.categorySlug}
              OR EXISTS (
                SELECT 1 FROM categories parent
                WHERE parent.id = c2.parent_id
                  AND parent.slug = ${filters.categorySlug}
              )
            )
        )
      `);
    }

    if (filters.county) {
      conditions.push(sql`l.location->>'county' ILIKE ${'%' + filters.county + '%'}`);
    }

    if (filters.area) {
      conditions.push(sql`l.location->>'area' ILIKE ${'%' + filters.area + '%'}`);
    }

    if (filters.minPrice) {
      conditions.push(sql`(l.price >= ${filters.minPrice.toString()} OR l.min_price >= ${filters.minPrice.toString()})`);
    }

    if (filters.maxPrice) {
      conditions.push(sql`(l.price <= ${filters.maxPrice.toString()} OR l.max_price <= ${filters.maxPrice.toString()})`);
    }

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(sql`(
        l.title       ILIKE ${term} OR
        l.description ILIKE ${term} OR
        l.location->>'county' ILIKE ${term} OR
        l.location->>'area'   ILIKE ${term}
      )`);
    }

    if (filters.vendorId) {
      conditions.push(sql`l.vendor_id = ${filters.vendorId}`);
    }

    const orderBy = (() => {
      switch (filters.sortBy) {
        case 'price':   return sql`l.price ASC NULLS LAST`;
        case 'popular': return sql`l.bookings_count DESC, l.views DESC`;
        default:        return sql`l.created_at DESC`;
      }
    })();

    const limit      = filters.limit  ?? 20;
    const offset     = filters.offset ?? 0;
    const whereClause = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

    const results = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `);

    await setCache(cacheKey, results, 300);
    return results as any[];
  }

  // ── My listings ───────────────────────────────────────────────────────────────
  async getMyListings(vendorId: string) {
    const rows = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE l.vendor_id = ${vendorId}
        AND l.status != 'deleted'
      ORDER BY l.updated_at DESC
    `);
    return rows as any[];
  }

  // ── Featured ──────────────────────────────────────────────────────────────────
  async getFeaturedListings(limit = 10) {
    const cacheKey = `listings:featured:${limit}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const featured = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE l.status = 'active'
      ORDER BY l.bookings_count DESC, l.views DESC
      LIMIT ${limit}
    `);

    await setCache(cacheKey, featured, 3600);
    return featured as any[];
  }

  // ── Admin: all listings ───────────────────────────────────────────────────────
  async getAllListings(filters?: ListingFilters) {
    const conditions = [sql`1=1`];

    if (filters?.status)   conditions.push(sql`l.status = ${filters.status}`);
    if (filters?.vendorId) conditions.push(sql`l.vendor_id = ${filters.vendorId}`);

    const whereClause = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
    const limit  = filters?.limit  ?? 50;
    const offset = filters?.offset ?? 0;

    const rows = await db.execute(sql`
      SELECT ${sql.raw(LISTING_SELECT)}
      ${sql.raw(LISTING_JOINS)}
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return rows as any[];
  }
}