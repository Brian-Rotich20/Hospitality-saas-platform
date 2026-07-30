import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { bookings, listings, users, vendors } from '../../db/schema/index.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { PayoutService } from '../payouts/payouts.service.js';
import type { CreateBookingInput, DeclineBookingInput, CancelBookingInput, GetBookingsInput } from './bookings.schema.js';
import type { PricingBreakdown } from './bookings.types.js';

const availabilityService = new AvailabilityService();
const payoutService       = new PayoutService();

export class BookingService {

  private readonly PLATFORM_FEE = 0.15; // 15%
  private readonly VAT           = 0.16; // 16%

  // ── Pricing 
  // Calculates total based on pricingType — snapshots currency from listing

  private calculatePricing(
    listing: { price: string | null; minPrice: string | null; pricingType: string; currency: string },
    nights: number,
    guests: number,
  ): PricingBreakdown {
    // Resolve the unit price — use price if set, fall back to minPrice for range
    const unitPrice = parseFloat(listing.price ?? listing.minPrice ?? '0');

    let baseAmount: number;

    switch (listing.pricingType) {
      case 'per_day':
        baseAmount = unitPrice * Math.max(nights, 1);
        break;
      case 'per_person':
        baseAmount = unitPrice * guests;
        break;
      case 'per_hour':
        // hours = nights * 24 makes no sense for hourly — treat as 1 unit minimum
        // Frontend should enforce proper hour selection; we just take unitPrice here
        baseAmount = unitPrice;
        break;
      case 'range':
        // minPrice is the floor — multiply by days
        baseAmount = unitPrice * Math.max(nights, 1);
        break;
      case 'package':
      case 'fixed':
      default:
        baseAmount = unitPrice;
        break;
    }

    const platformFee = baseAmount * this.PLATFORM_FEE;
    const subtotal    = baseAmount + platformFee;
    const vat         = subtotal * this.VAT;
    const totalAmount = subtotal + vat;

    return {
      baseAmount:  parseFloat(baseAmount.toFixed(2)),
      platformFee: parseFloat(platformFee.toFixed(2)),
      vat:         parseFloat(vat.toFixed(2)),
      totalAmount: parseFloat(totalAmount.toFixed(2)),
      pricingType: listing.pricingType,
      currency:    listing.currency,
      nights,
      guests,
    };
  }

  // ── Create booking

  async createBooking(customerId: string, data: CreateBookingInput) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, data.listingId),
    });

    if (!listing)                       throw new Error('Listing not found');
    if (listing.status !== 'active')    throw new Error('Listing is not available for booking');

    // Lead time check
    const today     = new Date();
    const startDate = new Date(data.startDate);
    const daysDiff  = Math.floor((startDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));



    // Availability check
    const isAvailable = await availabilityService.checkAvailability(
      data.listingId, data.startDate, data.endDate,
    );
    if (!isAvailable) throw new Error('Selected dates are not available');

    // Capacity check
   

    // Calculate nights
    const endDate = new Date(data.endDate);
    const nights  = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    // ✅ Pricing uses new flexible fields
    const pricing = this.calculatePricing(listing, nights, data.guests);

    const [booking] = await db.transaction(async (tx) => {
      // Race condition guard — double check within transaction
      const conflicts = await tx.query.bookings.findMany({
        where: and(
          eq(bookings.listingId, data.listingId),
          inArray(bookings.status, ['pending', 'confirmed']),
          sql`${bookings.startDate} <= ${data.endDate} AND ${bookings.endDate} >= ${data.startDate}`,
        ),
      });

      if (conflicts.length > 0) throw new Error('Selected dates are no longer available');

      return tx.insert(bookings).values({
        listingId:   data.listingId,
        customerId,
        startDate:   new Date(data.startDate),
        endDate:     new Date(data.endDate),
        guests:      data.guests,

        // ✅ Snapshot pricing type + currency from listing
        pricingType: pricing.pricingType,
        currency:    pricing.currency,

        baseAmount:  pricing.baseAmount.toString(),
        platformFee: pricing.platformFee.toString(),
        vat:         pricing.vat.toString(),
        totalAmount: pricing.totalAmount.toString(),

        specialRequests: data.specialRequests,
      }).returning();
    });

    // TODO: Notify vendor
    // TODO: If instantBooking, send confirmation to customer

    return { ...booking, pricing };
  }

  // ── Get by ID 

  async getBookingById(bookingId: string, userId: string, userRole: string) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: {
        listing: {
          with: { vendor: true },
        },
        customer: {
          columns: { id: true, email: true, phone: true },
        },
      },
    });

    if (!booking) throw new Error('Booking not found');

    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new Error('Unauthorized');
    }

    if (userRole === 'vendor') {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, userId),
      });
      if (!vendor || booking.listing.vendorId !== vendor.id) throw new Error('Unauthorized');
    }

    return booking;
  }

  // ── Accept

  async acceptBooking(bookingId: string, vendorId: string) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: { listing: true },
    });

    if (!booking)                              throw new Error('Booking not found');
    if (booking.listing.vendorId !== vendorId) throw new Error('Unauthorized');
    if (booking.status !== 'pending')          throw new Error(`Cannot accept a ${booking.status} booking`);

    const startStr = booking.startDate.toISOString().split('T')[0]!;
    const endStr   = booking.endDate.toISOString().split('T')[0]!;
    const isAvailable = await availabilityService.checkAvailability(booking.listingId, startStr, endStr);
    if (!isAvailable) throw new Error('Dates are no longer available');

    const [updated] = await db.update(bookings)
      .set({ status: 'confirmed', respondedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Send confirmation to customer
    return updated;
  }

  // ── Decline

  async declineBooking(bookingId: string, vendorId: string, data: DeclineBookingInput) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: { listing: true },
    });

    if (!booking)                              throw new Error('Booking not found');
    if (booking.listing.vendorId !== vendorId) throw new Error('Unauthorized');
    if (booking.status !== 'pending')          throw new Error(`Cannot decline a ${booking.status} booking`);

    const [updated] = await db.update(bookings)
      .set({ status: 'declined', declineReason: data.reason, respondedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Notify customer
    return updated;
  }

  // ── Cancel ────────────────────────────────────────────────────────────────────

  async cancelBooking(bookingId: string, customerId: string, data: CancelBookingInput) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
    });

    if (!booking)                          throw new Error('Booking not found');
    if (booking.customerId !== customerId) throw new Error('Unauthorized');

    if (!['pending', 'confirmed'].includes(booking.status)) {
      throw new Error(`Cannot cancel a ${booking.status} booking`);
    }

    if (booking.startDate <= new Date()) {
      throw new Error('Cannot cancel a booking that has already started');
    }

    const [updated] = await db.update(bookings)
      .set({ status: 'cancelled', cancellationReason: data.reason, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Process refund based on cancellation policy
    // TODO: Notify vendor
    return updated;
  }

  // ── Complete ──────────────────────────────────────────────────────────────────

  async completeBooking(bookingId: string) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
    });

    if (!booking)                        throw new Error('Booking not found');
    if (booking.status !== 'confirmed')  throw new Error('Only confirmed bookings can be completed');

    const endDate = new Date(booking.endDate);
    endDate.setHours(23, 59, 59);
    if (new Date() < endDate)            throw new Error('Booking cannot be completed before end date');

    const [completed] = await db.update(bookings)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();

    // Update listing bookings count
    await db.update(listings)
      .set({ bookingsCount: sql`${listings.bookingsCount} + 1` })
      .where(eq(listings.id, booking.listingId));

    // Trigger payout
    try {
      await payoutService.createPayoutForBooking(bookingId);
    } catch (error) {
      console.error('⚠️ Payout creation failed:', error);
    }

    return completed;
  }

  // ── Customer bookings ─────────────────────────────────────────────────────────

  async getCustomerBookings(customerId: string, filters?: GetBookingsInput) {
    const conditions: any[] = [eq(bookings.customerId, customerId)];
    if (filters?.status) conditions.push(eq(bookings.status, filters.status));

    return db.query.bookings.findMany({
      where: and(...conditions),
      with: {
        listing: {
          columns: { id: true, title: true, coverPhoto: true, location: true },
          with: {
            vendor: { columns: { businessName: true, phoneNumber: true, whatsappNumber: true } },
          },
        },
      },
      limit:   filters?.limit  ?? 20,
      offset:  filters?.offset ?? 0,
      orderBy: (bookings, { desc }) => [desc(bookings.createdAt)],
    });
  }

  // ── Vendor bookings ───────────────────────────────────────────────────────────

  async getVendorBookings(vendorId: string, filters?: GetBookingsInput) {
    const vendorListings = await db.query.listings.findMany({
      where: eq(listings.vendorId, vendorId),
      columns: { id: true },
    });

    const listingIds = vendorListings.map(l => l.id);
    if (listingIds.length === 0) return [];

    const conditions: any[] = [inArray(bookings.listingId, listingIds)];
    if (filters?.status) conditions.push(eq(bookings.status, filters.status));

    return db.query.bookings.findMany({
      where: and(...conditions),
      with: {
        listing:  { columns: { id: true, title: true, coverPhoto: true } },
        customer: { columns: { id: true, email: true, phone: true, fullName: true } },
      },
      limit:   filters?.limit  ?? 20,
      offset:  filters?.offset ?? 0,
      orderBy: (bookings, { desc }) => [desc(bookings.createdAt)],
    });
  }

  // ── Pending bookings (vendor dashboard) ──────────────────────────────────────

  async getPendingBookings(vendorId: string) {
    const vendorListings = await db.query.listings.findMany({
      where: eq(listings.vendorId, vendorId),
      columns: { id: true },
    });

    const listingIds = vendorListings.map(l => l.id);
    if (listingIds.length === 0) return [];

    return db.query.bookings.findMany({
      where: and(
        inArray(bookings.listingId, listingIds),
        eq(bookings.status, 'pending'),
      ),
      with: {
        listing:  { columns: { id: true, title: true } },
        customer: { columns: { email: true, phone: true, fullName: true } },
      },
      orderBy: (bookings, { asc }) => [asc(bookings.createdAt)],
    });
  }
}