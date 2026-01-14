import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { bookings, listings, users, vendors } from '../../db/schema';
import { AvailabilityService } from '../availability/availability.service';
import type { CreateBookingInput, DeclineBookingInput, CancelBookingInput, GetBookingsInput } from './bookings.schema';
import type { PricingBreakdown } from './bookings.types';
import { PayoutService } from '../payouts/payouts.service';

const payoutService = new PayoutService();

const availabilityService = new AvailabilityService();

export class BookingService {
  // Platform fee percentage
  private readonly PLATFORM_FEE_PERCENT = 0.15; // 15%
  private readonly VAT_PERCENT = 0.16; // 16%

  // Calculate pricing
  private calculatePricing(basePrice: number): PricingBreakdown {
    const baseAmount = basePrice;
    const platformFee = baseAmount * this.PLATFORM_FEE_PERCENT;
    const subtotal = baseAmount + platformFee;
    const vat = subtotal * this.VAT_PERCENT;
    const totalAmount = subtotal + vat;

    return {
      baseAmount: parseFloat(baseAmount.toFixed(2)),
      platformFee: parseFloat(platformFee.toFixed(2)),
      vat: parseFloat(vat.toFixed(2)),
      totalAmount: parseFloat(totalAmount.toFixed(2)),
    };
  }

  // Create booking request
  async createBooking(customerId: string, data: CreateBookingInput) {
    // Get listing
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, data.listingId),
    });

    if (!listing) {
      throw new Error('Listing not found');
    }

    if (listing.status !== 'active') {
      throw new Error('Listing is not available for booking');
    }

    // Check lead time
    const today = new Date();
    const startDate = new Date(data.startDate);
    const daysDiff = Math.floor((startDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff < (listing.leadTime || 1)) {
      throw new Error(`Booking must be made at least ${listing.leadTime} day(s) in advance`);
    }

    // Check availability
    const isAvailable = await availabilityService.checkAvailability(
      data.listingId,
      data.startDate,
      data.endDate
    );

    if (!isAvailable) {
      throw new Error('Selected dates are not available');
    }

    // Check capacity
    if (listing.capacity && data.guests > listing.capacity) {
      throw new Error(`Maximum capacity is ${listing.capacity} guests`);
    }

    // Calculate pricing
    const pricing = this.calculatePricing(parseFloat(listing.basePrice));

    // Create booking with row-level lock to prevent race conditions
    const [booking] = await db.transaction(async (tx) => {
      // Double-check availability within transaction
      const conflictingBookings = await tx.query.bookings.findMany({
        where: and(
          eq(bookings.listingId, data.listingId),
          inArray(bookings.status, ['pending', 'confirmed']),
          sql`${bookings.startDate} <= ${data.endDate} AND ${bookings.endDate} >= ${data.startDate}`
        ),
      });

      if (conflictingBookings.length > 0) {
        throw new Error('Selected dates are no longer available');
      }

      // Create booking
      return tx.insert(bookings).values({
        listingId: data.listingId,
        customerId,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        guests: data.guests,
        baseAmount: pricing.baseAmount.toString(),
        platformFee: pricing.platformFee.toString(),
        vat: pricing.vat.toString(),
        totalAmount: pricing.totalAmount.toString(),
        specialRequests: data.specialRequests,
        status: listing.instantBooking ? 'confirmed' : 'pending',
      }).returning();
    });

    // TODO: Send notification to vendor
    // TODO: If instant booking, send confirmation to customer

    return {
      ...booking,
      pricing,
    };
  }

  // Get booking by ID
  async getBookingById(bookingId: string, userId: string, userRole: string) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: {
        listing: {
          with: {
            vendor: true,
          },
        },
        customer: {
          columns: {
            id: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    // Authorization check
    if (userRole === 'customer' && booking.customerId !== userId) {
      throw new Error('Unauthorized');
    }

    if (userRole === 'vendor') {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, userId),
      });

      if (!vendor || booking.listing.vendorId !== vendor.id) {
        throw new Error('Unauthorized');
      }
    }

    return booking;
  }

  // Accept booking (vendor)
  async acceptBooking(bookingId: string, vendorId: string) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: {
        listing: true,
      },
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    if (booking.status !== 'pending') {
      throw new Error(`Cannot accept booking with status: ${booking.status}`);
    }

    // Check if still available
    
    const startDateStr = booking.startDate.toISOString().split('T')[0]!;
    const endDateStr = booking.endDate.toISOString().split('T')[0]!;
    const isAvailable = await availabilityService.checkAvailability(
        booking.listingId,
        startDateStr,
        endDateStr
        );
   

    if (!isAvailable) {
      throw new Error('Dates are no longer available');
    }

    // Accept booking
    const [acceptedBooking] = await db.update(bookings)
      .set({
        status: 'confirmed',
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Send confirmation to customer
    // TODO: Create payment record

    return acceptedBooking;
  }

  // Decline booking (vendor)
  async declineBooking(bookingId: string, vendorId: string, data: DeclineBookingInput) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: {
        listing: true,
      },
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.listing.vendorId !== vendorId) {
      throw new Error('Unauthorized');
    }

    if (booking.status !== 'pending') {
      throw new Error(`Cannot decline booking with status: ${booking.status}`);
    }

    const [declinedBooking] = await db.update(bookings)
      .set({
        status: 'declined',
        declineReason: data.reason,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Notify customer

    return declinedBooking;
  }

  // Cancel booking (customer)
  async cancelBooking(bookingId: string, customerId: string, data: CancelBookingInput) {
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new Error('Unauthorized');
    }

    if (!['pending', 'confirmed'].includes(booking.status)) {
      throw new Error(`Cannot cancel booking with status: ${booking.status}`);
    }

    // Check if already started
    const today = new Date();
    if (booking.startDate <= today) {
      throw new Error('Cannot cancel booking that has already started');
    }

    const [cancelledBooking] = await db.update(bookings)
      .set({
        status: 'cancelled',
        cancellationReason: data.reason,
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    // TODO: Process refund based on cancellation policy
    // TODO: Notify vendor

    return cancelledBooking;
  }

    // Mark booking as completed
    async completeBooking(bookingId: string) {
        const booking = await db.query.bookings.findFirst({
            where: eq(bookings.id, bookingId),
        });

        
        if (!booking) {
            throw new Error('Booking not found');
        }

        if (booking.status !== 'confirmed') {
            throw new Error('Only confirmed bookings can be completed');
        }
        // Check if end date has passed
        const today = new Date();
        const endDate = new Date(booking.endDate);
        endDate.setHours(23, 59, 59);

        if (today < endDate) {
            throw new Error('Booking cannot be completed before end date');
        }

        const [completedBooking] = await db.update(bookings)
            .set({
                status: 'completed',
                completedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(bookings.id, bookingId))
            .returning();

        // Update listing bookings count
        await db.update(listings)
            .set({
                bookingsCount: sql`${listings.bookingsCount} + 1`,
            })
            .where(eq(listings.id, booking.listingId));

        // TODO: Trigger payout process
        try {
          await payoutService.createPayoutForBooking(bookingId);
          console.log(`✅ Payout created for booking ${bookingId}`);
        } catch (error) {
          console.error('⚠️ Payout creation failed:', error);
        }

        return completedBooking;
    }
    // Get customer bookings
    async getCustomerBookings(customerId: string, filters?: GetBookingsInput) {
        const conditions = [eq(bookings.customerId, customerId)];
        if (filters?.status) {
            conditions.push(eq(bookings.status, filters.status));
        }

        const customerBookings = await db.query.bookings.findMany({
            where: and(...conditions),
            with: {
                listing: {
                    columns: {
                        id: true,
                        title: true,
                        coverPhoto: true,
                        location: true,
                    },
                    with: {
                        vendor: {
                            columns: {
                                businessName: true,
                                phoneNumber: true,
                            },
                        },
                    },
                },
            },
            limit: filters?.limit || 20,
            offset: filters?.offset || 0,
            orderBy: (bookings, { desc }) => [desc(bookings.createdAt)],
        });

        return customerBookings;
    }
    // Get vendor bookings
    async getVendorBookings(vendorId: string, filters?: GetBookingsInput) {
        const conditions = [];
        if (filters?.status) {
            conditions.push(eq(bookings.status, filters.status));
        }

        // Get all listings for vendor
        const vendorListings = await db.query.listings.findMany({
            where: eq(listings.vendorId, vendorId),
            columns: { id: true },
        });

        const listingIds = vendorListings.map(l => l.id);

        if (listingIds.length === 0) {
            return [];
        }

        conditions.push(inArray(bookings.listingId, listingIds));

        const vendorBookings = await db.query.bookings.findMany({
            where: and(...conditions),
            with: {
                listing: {
                    columns: {
                        id: true,
                        title: true,
                        coverPhoto: true,
                    },
                },
                customer: {
                    columns: {
                        id: true,
                        email: true,
                        phone: true,
                    },
                },
            },
            limit: filters?.limit || 20,
            offset: filters?.offset || 0,
            orderBy: (bookings, { desc }) => [desc(bookings.createdAt)],
        });

        return vendorBookings;
    }
    // Get pending bookings (vendor) - for dashboard alerts
    async getPendingBookings(vendorId: string) {
        const vendorListings = await db.query.listings.findMany({
            where: eq(listings.vendorId, vendorId),
            columns: { id: true },
        });
        const listingIds = vendorListings.map(l => l.id);

        if (listingIds.length === 0) {
            return [];
        }

        const pendingBookings = await db.query.bookings.findMany({
            where: and(
                inArray(bookings.listingId, listingIds),
                eq(bookings.status, 'pending')
            ),
            with: {
                listing: {
                    columns: {
                        id: true,
                        title: true,
                    },
                },
                customer: {
                    columns: {
                        email: true,
                        phone: true,
                    },
                },
            },
            orderBy: (bookings, { asc }) => [asc(bookings.createdAt)],
        });

        return pendingBookings;
    }
}
