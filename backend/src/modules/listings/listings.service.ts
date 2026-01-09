import { eq, and, or, gte, lte, like, sql, desc, asc } from 'drizzle-orm';
import { db } from '../../config/database';
import { listings, vendors } from '../../db/schema';
import { setCache, getCache, delCache } from '../../config/redis';
import type { 
  CreateListingInput, 
  UpdateListingInput,
  PublishListingInput,
  ListingFilters 
} from './listings.schema';

export class ListingService {
  // Generate URL-friendly slug
  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '-' + Date.now();
  }

  // Create listing
  async createListing(vendorId: string, data: CreateListingInput) {
    // Verify vendor is approved
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    if (vendor.status !== 'approved') {
      throw new Error('Only approved vendors can create listings');
    }

    // Generate slug
    const slug = this.generateSlug(data.title);

    // Set cover photo to first photo if not provided
    const coverPhoto = data.coverPhoto || data.photos[0];

    // Create listing
    const [listing] = await db.insert(listings).values({
      vendorId,
      title: data.title,
      slug,
      description: data.description,
      category: data.category,
      location: data.location,
      address: data.address,
      county: data.county,
      city: data.city,
      latitude: data.latitude?.toString(),
      longitude: data.longitude?.toString(),
      capacity: data.capacity,
      basePrice: data.basePrice.toString(),
      photos: data.photos,
      coverPhoto,
      amenities: data.amenities,
      instantBooking: data.instantBooking,
      minBookingDuration: data.minBookingDuration,
      maxBookingDuration: data.maxBookingDuration,
      leadTime: data.leadTime,
      status: 'draft',
    }).returning();

    return listing;
  }

  // Get listing by ID
  async getListingById(listingId: string, includeVendor: boolean = false) {
    const cacheKey = `listing:${listingId}`;
    
    // Check cache
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
      with: includeVendor ? {
        vendor: {
          columns: {
            id: true,
            businessName: true,
            businessType: true,
            location: true,
          },
        },
      } : undefined,
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    // Increment views
    await db.update(listings)
      .set({ views: sql`${listings.views} + 1` })
      .where(eq(listings.id, listingId));

    // Cache for 10 minutes
    await setCache(cacheKey, listing, 600);

    return listing;
  }

  // Get listing by slug (for public URLs)
  async getListingBySlug(slug: string) {
    const cacheKey = `listing:slug:${slug}`;
    
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    const listing = await db.query.listings.findFirst({
      where: eq(listings.slug, slug),
      with: {
        vendor: {
          columns: {
            id: true,
            businessName: true,
            businessType: true,
            location: true,
            phoneNumber: true,
          },
        },
      },
    });

    if (!listing || listing.status === 'deleted') {
      throw new Error('Listing not found');
    }

    // Increment views
    await db.update(listings)
      .set({ views: sql`${listings.views} + 1` })
      .where(eq(listings.id, listing.id));

    await setCache(cacheKey, listing, 600);

    return listing;
  }

  // Update listing
  async updateListing(listingId: string, vendorId: string, data: UpdateListingInput) {
    // Verify ownership
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.vendorId !== vendorId) {
      throw new Error('Unauthorized: You do not own this listing');
    }

    // Update slug if title changed
    const updateData: any = { ...data };
    if (data.title) {
      updateData.slug = this.generateSlug(data.title);
    }

    // Convert numbers to strings for decimal fields
    if (data.basePrice) {
      updateData.basePrice = data.basePrice.toString();
    }
    if (data.latitude) {
      updateData.latitude = data.latitude.toString();
    }
    if (data.longitude) {
      updateData.longitude = data.longitude.toString();
    }

    updateData.updatedAt = new Date();

    const [updatedListing] = await db.update(listings)
      .set(updateData)
      .where(eq(listings.id, listingId))
      .returning();

    // Invalidate cache
    await delCache(`listing:${listingId}`);
    await delCache(`listing:slug:${listing.slug}`);

    return updatedListing;
  }

  // Publish/unpublish listing
  async updateListingStatus(listingId: string, vendorId: string, status: 'active' | 'paused') {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    // Validate listing has minimum required data before publishing
    if (status === 'active') {
      if (!listing.photos || listing.photos.length === 0) {
        throw new Error('Cannot publish listing without photos');
      }
      if (!listing.basePrice || parseFloat(listing.basePrice) <= 0) {
        throw new Error('Cannot publish listing without valid price');
      }
    }

    const [updatedListing] = await db.update(listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(listings.id, listingId))
      .returning();

    // Invalidate cache
    await delCache(`listing:${listingId}`);

    return updatedListing;
  }

  // Delete listing (soft delete)
  async deleteListing(listingId: string, vendorId: string) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    const [deletedListing] = await db.update(listings)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(eq(listings.id, listingId))
      .returning();

    // Invalidate cache
    await delCache(`listing:${listingId}`);
    await delCache(`listing:slug:${listing.slug}`);

    return deletedListing;
  }

  // Search/browse listings (public)
  async searchListings(filters: ListingFilters) {
    const cacheKey = `listings:search:${JSON.stringify(filters)}`;
    
    // Check cache (5 min TTL for search results)
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    const conditions = [
      eq(listings.status, 'active'),
    ];

    // Apply filters
    if (filters.category) {
      conditions.push(eq(listings.category, filters.category));
    }

    if (filters.location) {
      conditions.push(
        or(
          like(listings.location, `%${filters.location}%`),
          like(listings.county, `%${filters.location}%`),
          like(listings.city, `%${filters.location}%`)
        )!
      );
    }

    if (filters.minPrice) {
      conditions.push(gte(listings.basePrice, filters.minPrice.toString()));
    }

    if (filters.maxPrice) {
      conditions.push(lte(listings.basePrice, filters.maxPrice.toString()));
    }

    if (filters.minCapacity) {
      conditions.push(gte(listings.capacity, filters.minCapacity));
    }

    if (filters.search) {
      conditions.push(
        or(
          like(listings.title, `%${filters.search}%`),
          like(listings.description, `%${filters.search}%`)
        )!
      );
    }

    const results = await db.query.listings.findMany({
      where: and(...conditions),
      with: {
        vendor: {
          columns: {
            id: true,
            businessName: true,
            businessType: true,
          },
        },
      },
      limit: filters.limit || 20,
      offset: filters.offset || 0,
      orderBy: [desc(listings.createdAt)],
    });

    // Cache for 5 minutes
    await setCache(cacheKey, results, 300);

    return results;
  }

  // Get vendor's listings
  async getVendorListings(vendorId: string, includeAll: boolean = false) {
    const conditions = [eq(listings.vendorId, vendorId)];

    if (!includeAll) {
      conditions.push(eq(listings.status, 'active'));
    }

    const vendorListings = await db.query.listings.findMany({
      where: and(...conditions),
      orderBy: [desc(listings.createdAt)],
    });

    return vendorListings;
  }

  // Get my listings (for authenticated vendor)
  async getMyListings(vendorId: string) {
    const myListings = await db.query.listings.findMany({
      where: and(
        eq(listings.vendorId, vendorId),
        sql`${listings.status} != 'deleted'`
      ),
      orderBy: [desc(listings.updatedAt)],
    });

    return myListings;
  }

  // Get featured/popular listings
  async getFeaturedListings(limit: number = 10) {
    const cacheKey = `listings:featured:${limit}`;
    
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    const featured = await db.query.listings.findMany({
      where: eq(listings.status, 'active'),
      with: {
        vendor: {
          columns: {
            id: true,
            businessName: true,
          },
        },
      },
      orderBy: [desc(listings.views), desc(listings.bookingsCount)],
      limit,
    });

    // Cache for 1 hour
    await setCache(cacheKey, featured, 3600);

    return featured;
  }

  // Admin: Get all listings
  async getAllListings(filters?: ListingFilters) {
    const conditions = [];

    if (filters?.status) {
      conditions.push(eq(listings.status, filters.status));
    }

    if (filters?.vendorId) {
      conditions.push(eq(listings.vendorId, filters.vendorId));
    }

    const allListings = await db.query.listings.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        vendor: {
          columns: {
            id: true,
            businessName: true,
            status: true,
          },
        },
      },
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
      orderBy: [desc(listings.createdAt)],
    });

    return allListings;
  }
}