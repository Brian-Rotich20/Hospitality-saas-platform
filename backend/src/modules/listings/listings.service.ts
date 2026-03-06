import { eq, and, or, gte, lte, ilike, sql, desc, asc } from 'drizzle-orm';
import { db } from '../../config/database';
import { listings, vendors, categories } from '../../db/schema';
import { setCache, getCache, delCache } from '../../config/redis';
import type { ListingFilters } from './listings.types';
import type { CreateListingInput, UpdateListingInput } from './listings.schema';

export class ListingService {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + Date.now();
  }

  // Validate vendor is approved before any write operation
  private async getApprovedVendor(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor)              throw new Error('Vendor not found');
    if (vendor.status !== 'approved') throw new Error('Only approved vendors can manage listings');
    return vendor;
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  async createListing(vendorId: string, data: CreateListingInput) {
    await this.getApprovedVendor(vendorId);

    // Validate category exists
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

      // ✅ Structured jsonb location
      location: data.location,

      capacity: data.capacity,

      // ✅ Flexible pricing
      pricingType: data.pricingType,
      price:       data.price?.toString(),
      minPrice:    data.minPrice?.toString(),
      maxPrice:    data.maxPrice?.toString(),
      currency:    data.currency ?? 'KES',

      photos:     data.photos ?? [],
      coverPhoto,
      amenities:  data.amenities ?? [],

      instantBooking:     data.instantBooking     ?? false,
      minBookingDuration: data.minBookingDuration ?? 1,
      maxBookingDuration: data.maxBookingDuration ?? 30,
      leadTime:           data.leadTime           ?? 1,

      status: 'draft',
    }).returning();

    return listing;
  }

  // ── Read: by ID ───────────────────────────────────────────────────────────────

  async getListingById(listingId: string, includeRelations = false) {
    const cacheKey = `listing:${listingId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
      with: includeRelations ? {
        vendor: {
          columns: {
            id: true, businessName: true, slug: true,
            logo: true, whatsappNumber: true, verified: true,
            phoneNumber: true, city: true,
          },
        },
        category: {
          columns: { id: true, name: true, slug: true, icon: true },
        },
      } : undefined,
    });

    if (!listing) throw new Error('Listing not found');

    // Increment views async — don't block the response
    db.update(listings)
      .set({ views: sql`${listings.views} + 1` })
      .where(eq(listings.id, listingId))
      .execute();

    await setCache(cacheKey, listing, 600);
    return listing;
  }

  // ── Read: by slug ─────────────────────────────────────────────────────────────

  async getListingBySlug(slug: string) {
    const cacheKey = `listing:slug:${slug}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const listing = await db.query.listings.findFirst({
      where: eq(listings.slug, slug),
      with: {
        vendor: {
          columns: {
            id: true, businessName: true, slug: true,
            logo: true, whatsappNumber: true, phoneNumber: true,
            verified: true, city: true,
          },
        },
        category: {
          columns: { id: true, name: true, slug: true, icon: true },
        },
      },
    });

    if (!listing || listing.status === 'deleted') throw new Error('Listing not found');

    db.update(listings)
      .set({ views: sql`${listings.views} + 1` })
      .where(eq(listings.id, listing.id))
      .execute();

    await setCache(cacheKey, listing, 600);
    return listing;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async updateListing(listingId: string, vendorId: string, data: UpdateListingInput) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });
    if (!listing)                       throw new Error('Listing not found');
    if (listing.vendorId !== vendorId)  throw new Error('Unauthorized');

    // Validate new category if provided
    if (data.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, data.categoryId),
      });
      if (!cat) throw new Error('Invalid category');
    }

    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (data.title)       updateData.slug        = this.generateSlug(data.title);
    if (data.title)       updateData.title       = data.title;
    if (data.description) updateData.description = data.description;
    if (data.categoryId)  updateData.categoryId  = data.categoryId;
    if (data.location)    updateData.location    = data.location;
    if (data.capacity)    updateData.capacity    = data.capacity;
    if (data.amenities)   updateData.amenities   = data.amenities;
    if (data.photos)      updateData.photos      = data.photos;
    if (data.coverPhoto)  updateData.coverPhoto  = data.coverPhoto;

    // Pricing fields
    if (data.pricingType) updateData.pricingType = data.pricingType;
    if (data.price != null)    updateData.price    = data.price.toString();
    if (data.minPrice != null) updateData.minPrice = data.minPrice.toString();
    if (data.maxPrice != null) updateData.maxPrice = data.maxPrice.toString();
    if (data.currency)    updateData.currency    = data.currency;

    // Booking settings
    if (data.instantBooking     != null) updateData.instantBooking     = data.instantBooking;
    if (data.minBookingDuration != null) updateData.minBookingDuration = data.minBookingDuration;
    if (data.maxBookingDuration != null) updateData.maxBookingDuration = data.maxBookingDuration;
    if (data.leadTime           != null) updateData.leadTime           = data.leadTime;

    const [updated] = await db.update(listings)
      .set(updateData)
      .where(eq(listings.id, listingId))
      .returning();

    await delCache(`listing:${listingId}`);
    await delCache(`listing:slug:${listing.slug}`);

    return updated;
  }

  // ── Status (publish/pause) ────────────────────────────────────────────────────

  async updateListingStatus(listingId: string, vendorId: string, status: 'active' | 'paused') {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });
    if (!listing)                      throw new Error('Listing not found');
    if (listing.vendorId !== vendorId) throw new Error('Unauthorized');

    if (status === 'active') {
      if (!listing.photos || (listing.photos as string[]).length === 0)
        throw new Error('Add at least one photo before publishing');

      // Must have a price set for non-package listings
      if (listing.pricingType !== 'package' && !listing.price && !listing.minPrice)
        throw new Error('Set a price before publishing');
    }

    const [updated] = await db.update(listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(listings.id, listingId))
      .returning();

    await delCache(`listing:${listingId}`);
    return updated;
  }

  // ── Delete (soft) ─────────────────────────────────────────────────────────────

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

    const conditions: any[] = [eq(listings.status, 'active')];

    // ✅ Filter by categoryId (dynamic) or slug
    if (filters.categoryId) {
      conditions.push(eq(listings.categoryId, filters.categoryId));
    } else if (filters.categorySlug) {
      // Join via subquery — find category ID from slug first
      const cat = await db.query.categories.findFirst({
        where: eq(categories.slug, filters.categorySlug),
      });
      if (cat) conditions.push(eq(listings.categoryId, cat.id));
    }

    // ✅ Location search inside jsonb field
    if (filters.city) {
      conditions.push(
        sql`${listings.location}->>'city' ILIKE ${'%' + filters.city + '%'}`
      );
    }

    // ✅ Price filter — works across pricingType variants
    if (filters.minPrice) {
      conditions.push(
        or(
          gte(listings.price,    filters.minPrice.toString()),
          gte(listings.minPrice, filters.minPrice.toString()),
        )
      );
    }
    if (filters.maxPrice) {
      conditions.push(
        or(
          lte(listings.price,    filters.maxPrice.toString()),
          lte(listings.maxPrice, filters.maxPrice.toString()),
        )
      );
    }

    if (filters.minCapacity) {
      conditions.push(gte(listings.capacity, filters.minCapacity));
    }

    if (filters.search) {
      conditions.push(
        or(
          ilike(listings.title,       `%${filters.search}%`),
          ilike(listings.description, `%${filters.search}%`),
          sql`${listings.location}->>'city' ILIKE ${'%' + filters.search + '%'}`,
        )
      );
    }

    if (filters.vendorId) {
      conditions.push(eq(listings.vendorId, filters.vendorId));
    }

    // ✅ Sorting
    const orderBy = (() => {
      switch (filters.sortBy) {
        case 'price':   return [asc(listings.price)];
        case 'popular': return [desc(listings.bookingsCount), desc(listings.views)];
        default:        return [desc(listings.createdAt)];  // newest
      }
    })();

    const results = await db.query.listings.findMany({
      where:   and(...conditions),
      with: {
        vendor: {
          columns: {
            id: true, businessName: true, slug: true,
            logo: true, verified: true,
          },
        },
        category: {
          columns: { id: true, name: true, slug: true, icon: true },
        },
      },
      orderBy,
      limit:  filters.limit  ?? 20,
      offset: filters.offset ?? 0,
    });

    await setCache(cacheKey, results, 300);
    return results;
  }

  // ── My listings (vendor dashboard) ───────────────────────────────────────────

  async getMyListings(vendorId: string) {
    return db.query.listings.findMany({
      where: and(
        eq(listings.vendorId, vendorId),
        sql`${listings.status} != 'deleted'`
      ),
      with: {
        category: {
          columns: { id: true, name: true, slug: true, icon: true },
        },
      },
      orderBy: [desc(listings.updatedAt)],
    });
  }

  // ── Featured / homepage ───────────────────────────────────────────────────────

  async getFeaturedListings(limit = 10) {
    const cacheKey = `listings:featured:${limit}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const featured = await db.query.listings.findMany({
      where: eq(listings.status, 'active'),
      with: {
        vendor: {
          columns: { id: true, businessName: true, slug: true, logo: true, verified: true },
        },
        category: {
          columns: { id: true, name: true, slug: true, icon: true },
        },
      },
      orderBy: [desc(listings.bookingsCount), desc(listings.views)],
      limit,
    });

    await setCache(cacheKey, featured, 3600);
    return featured;
  }

  // ── Admin ─────────────────────────────────────────────────────────────────────

  async getAllListings(filters?: ListingFilters) {
    const conditions: any[] = [];

    if (filters?.status)   conditions.push(eq(listings.status,   filters.status));
    if (filters?.vendorId) conditions.push(eq(listings.vendorId, filters.vendorId));

    return db.query.listings.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        vendor: {
          columns: { id: true, businessName: true, status: true },
        },
        category: {
          columns: { id: true, name: true, slug: true },
        },
      },
      limit:   filters?.limit  ?? 50,
      offset:  filters?.offset ?? 0,
      orderBy: [desc(listings.createdAt)],
    });
  }
}