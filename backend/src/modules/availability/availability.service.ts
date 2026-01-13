import { eq, and, between, inArray, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { availability, listings, bookings } from '../../db/schema';
import { setCache, getCache, delCache } from '../../config/redis';
import type { BlockDatesInput, UnblockDatesInput, CheckAvailabilityInput } from './availability.schema';

export class AvailabilityService {
  // Block dates for a listing
  async blockDates(listingId: string, vendorId: string, data: BlockDatesInput) {
    // Verify ownership
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    // Block each date
    const blockedDates = [];
    for (const dateStr of data.dates) {
      const existingAvailability = await db.query.availability.findFirst({
        where: and(
          eq(availability.listingId, listingId),
          eq(availability.date, dateStr)
        ),
      });

      if (existingAvailability) {
        // Update existing
        const [updated] = await db.update(availability)
          .set({
            available: false,
            blockedReason: data.reason,
            updatedAt: new Date(),
          })
          .where(eq(availability.id, existingAvailability.id))
          .returning();
        
        blockedDates.push(updated);
      } else {
        // Insert new
        const [newAvailability] = await db.insert(availability).values({
          listingId,
          date: dateStr,
          available: false,
          blockedReason: data.reason,
        }).returning();
        
        blockedDates.push(newAvailability);
      }
    }

    // Invalidate cache
    await delCache(`availability:${listingId}`);

    return blockedDates;
  }

  // Unblock dates
  async unblockDates(listingId: string, vendorId: string, data: UnblockDatesInput) {
    // Verify ownership
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    // Unblock each date
    const unblockedDates = [];
    for (const dateStr of data.dates) {
      const existingAvailability = await db.query.availability.findFirst({
        where: and(
          eq(availability.listingId, listingId),
          eq(availability.date, dateStr)
        ),
      });

      if (existingAvailability) {
        const [updated] = await db.update(availability)
          .set({
            available: true,
            blockedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(availability.id, existingAvailability.id))
          .returning();
        
        unblockedDates.push(updated);
      }
    }

    // Invalidate cache
    await delCache(`availability:${listingId}`);

    return unblockedDates;
  }

  // Check if date range is available
  async checkAvailability(listingId: string, startDate: string, endDate: string): Promise<boolean> {
    // Check blocked dates in availability table
    const blockedDates = await db.query.availability.findMany({
      where: and(
        eq(availability.listingId, listingId),
        gte(availability.date, startDate),
        lte(availability.date, endDate),
        eq(availability.available, false)
      ),
    });

    if (blockedDates.length > 0) {
      return false;
    }

    // Check existing bookings
    const existingBookings = await db.query.bookings.findMany({
      where: and(
        eq(bookings.listingId, listingId),
        inArray(bookings.status, ['pending', 'confirmed']),
        sql`${bookings.startDate} <= ${endDate} AND ${bookings.endDate} >= ${startDate}`
      ),
    });

    return existingBookings.length === 0;
  }

  // Get calendar (all dates with availability status)
  async getCalendar(listingId: string, startDate: string, endDate: string) {
    const cacheKey = `calendar:${listingId}:${startDate}:${endDate}`;
    
    // Check cache
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Get blocked dates
    const blockedDates = await db.query.availability.findMany({
      where: and(
        eq(availability.listingId, listingId),
        gte(availability.date, startDate),
        lte(availability.date, endDate)
      ),
    });

    // Get booked dates
    const bookedDates = await db.query.bookings.findMany({
      where: and(
        eq(bookings.listingId, listingId),
        inArray(bookings.status, ['pending', 'confirmed']),
        gte(bookings.startDate, new Date(startDate)),
        lte(bookings.endDate, new Date(endDate))
      ),
      columns: {
        startDate: true,
        endDate: true,
        status: true,
      },
    });

    // Build calendar object
    const calendar: Record<string, { available: boolean; reason?: string; booking?: any }> = {};

    // Mark blocked dates
    blockedDates.forEach(date => {
      calendar[date.date] = {
        available: date.available,
        reason: date.blockedReason || undefined,
      };
    });

    // Mark booked dates
    bookedDates.forEach(booking => {
      const start = new Date(booking.startDate);
      const end = new Date(booking.endDate);
      
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        calendar[dateStr] = {
          available: false,
          reason: 'Booked',
          booking: { status: booking.status },
        };
      }
    });

    // Cache for 5 minutes
    await setCache(cacheKey, calendar, 300);

    return calendar;
  }

  // Get all availability for a listing
  async getListingAvailability(listingId: string) {
    const allAvailability = await db.query.availability.findMany({
      where: eq(availability.listingId, listingId),
      orderBy: (availability, { asc }) => [asc(availability.date)],
    });

    return allAvailability;
  }
}