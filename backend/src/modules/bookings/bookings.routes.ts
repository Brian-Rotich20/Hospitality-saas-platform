import { FastifyInstance } from 'fastify';
import { BookingController } from './bookings.controller';
import { db }               from '../../config/database';
import { bookings, listings, users } from '../../db/schema';
import { eq, desc }         from 'drizzle-orm';

const bookingController = new BookingController();

export async function bookingRoutes(fastify: FastifyInstance) {

  // ── Customer routes ───────────────────────────────────────────────────────

  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Create new booking request' },
  }, bookingController.createBooking.bind(bookingController));

  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Get my bookings' },
  }, bookingController.getMyBookings.bind(bookingController));

  fastify.put('/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Cancel booking' },
  }, bookingController.cancelBooking.bind(bookingController));

  // ── Vendor routes ─────────────────────────────────────────────────────────

  fastify.get('/vendor', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Get vendor bookings' },
  }, bookingController.getVendorBookings.bind(bookingController));

  fastify.get('/vendor/pending', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Get pending bookings' },
  }, bookingController.getPendingBookings.bind(bookingController));

  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Get booking details' },
  }, bookingController.getBookingById.bind(bookingController));

  fastify.put('/:id/accept', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Accept booking' },
  }, bookingController.acceptBooking.bind(bookingController));

  fastify.put('/:id/decline', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Bookings'], description: 'Decline booking' },
  }, bookingController.declineBooking.bind(bookingController));
}

// ── Admin bookings routes ─────────────────────────────────────────────────────
// Registered separately at prefix /api/admin/bookings in app.ts

export async function bookingAdminRoutes(fastify: FastifyInstance) {

  // GET /api/admin/bookings
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Bookings'],
      description: 'Get all bookings with customer and listing info',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit:  { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { status, limit = 50, offset = 0 } = request.query as {
        status?: string;
        limit?:  number;
        offset?: number;
      };

      const rows = await db
        .select({
          id:            bookings.id,
          status:        bookings.status,
          totalAmount:   bookings.totalAmount,
          baseAmount:    bookings.baseAmount,
          platformFee:   bookings.platformFee,
          currency:      bookings.currency,
          startDate:     bookings.startDate,
          endDate:       bookings.endDate,
          guests:        bookings.guests,
          pricingType:   bookings.pricingType,
          specialRequests:    bookings.specialRequests,
          cancellationReason: bookings.cancellationReason,
          createdAt:     bookings.createdAt,
          updatedAt:     bookings.updatedAt,
          // Listing
          listingId:     listings.id,
          listingTitle:  listings.title,
          // Customer
          customerId:    users.id,
          customerEmail: users.email,
          customerName:  users.fullName,
        })
        .from(bookings)
        .leftJoin(listings, eq(listings.id, bookings.listingId))
        .leftJoin(users,    eq(users.id,     bookings.customerId))
        .where(status ? eq(bookings.status, status as any) : undefined)
        .limit(Number(limit))
        .offset(Number(offset))
        .orderBy(desc(bookings.createdAt));

      const data = rows.map(r => ({
        id:            r.id,
        status:        r.status,
        totalAmount:   r.totalAmount,
        baseAmount:    r.baseAmount,
        platformFee:   r.platformFee,
        currency:      r.currency,
        startDate:     r.startDate,
        endDate:       r.endDate,
        guests:        r.guests,
        pricingType:   r.pricingType,
        specialRequests:    r.specialRequests,
        cancellationReason: r.cancellationReason,
        createdAt:     r.createdAt,
        updatedAt:     r.updatedAt,
        listing:  { id: r.listingId,   title: r.listingTitle  },
        customer: { id: r.customerId,  email: r.customerEmail, fullName: r.customerName },
      }));

      return reply.send({ success: true, data, count: data.length });
    } catch (error: any) {
      return reply.code(500).send({ success: false, error: error.message });
    }
  });

  // GET /api/admin/bookings/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Bookings'],
      description: 'Get single booking details',
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const rows = await db
        .select({
          id:            bookings.id,
          status:        bookings.status,
          totalAmount:   bookings.totalAmount,
          baseAmount:    bookings.baseAmount,
          platformFee:   bookings.platformFee,
          currency:      bookings.currency,
          startDate:     bookings.startDate,
          endDate:       bookings.endDate,
          guests:        bookings.guests,
          pricingType:   bookings.pricingType,
          specialRequests:    bookings.specialRequests,
          cancellationReason: bookings.cancellationReason,
          declineReason:      bookings.declineReason,
          createdAt:     bookings.createdAt,
          listingId:     listings.id,
          listingTitle:  listings.title,
          customerId:    users.id,
          customerEmail: users.email,
          customerName:  users.fullName,
        })
        .from(bookings)
        .leftJoin(listings, eq(listings.id, bookings.listingId))
        .leftJoin(users,    eq(users.id,     bookings.customerId))
        .where(eq(bookings.id, id))
        .limit(1);

      if (!rows[0]) {
        return reply.code(404).send({ success: false, error: 'Booking not found' });
      }

      const r = rows[0];
      return reply.send({
        success: true,
        data: {
          ...r,
          listing:  { id: r.listingId,   title: r.listingTitle  },
          customer: { id: r.customerId,  email: r.customerEmail, fullName: r.customerName },
        },
      });
    } catch (error: any) {
      return reply.code(500).send({ success: false, error: error.message });
    }
  });
}