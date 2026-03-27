import { FastifyInstance } from 'fastify';
import { BookingController } from './bookings.controller';
import { eq, desc }          from 'drizzle-orm';
import { z }                 from 'zod';
import { db }                from '../../config/database';

// ✅ Import directly from individual schema files — NOT barrel index
import { bookings } from '../../db/schema/bookings';
import { listings } from '../../db/schema/listings';
import { users }    from '../../db/schema/users';

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

// ── Admin bookings routes 
const bookingQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'declined', 'disputed']).optional(),
  limit:  z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type BookingQuery = z.infer<typeof bookingQuerySchema>;

export async function bookingAdminRoutes(fastify: FastifyInstance) {

  // GET /api/admin/bookings
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Bookings'],
      description: 'Get all bookings',
      querystring: bookingQuerySchema,  // ✅ Zod schema
    },
  }, async (request, reply) => {
    try {
      const { status, limit = 50, offset = 0 } = request.query as BookingQuery; // ✅ fully typed, no cast

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
        .where(status ? eq(bookings.status, status as 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'declined' | 'disputed') : undefined)
        .limit(limit)        // ✅ already a number via z.coerce
        .offset(offset)      // ✅ already a number via z.coerce
        .orderBy(desc(bookings.createdAt));

      const data = rows.map(r => ({
        id:          r.id,
        status:      r.status,
        totalAmount: r.totalAmount,
        baseAmount:  r.baseAmount,
        platformFee: r.platformFee,
        currency:    r.currency,
        startDate:   r.startDate,
        endDate:     r.endDate,
        guests:      r.guests,
        pricingType: r.pricingType,
        createdAt:   r.createdAt,
        listing:  { id: r.listingId,  title: r.listingTitle },
        customer: { id: r.customerId, email: r.customerEmail, fullName: r.customerName },
      }));

      return reply.send({ success: true, data, count: data.length });
    } catch (error: any) {
      return reply.code(500).send({ success: false, error: error.message });
    }
  });

  // GET /api/admin/bookings/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Bookings'], description: 'Get single booking' },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const rows = await db
        .select({
          id:                 bookings.id,
          status:             bookings.status,
          totalAmount:        bookings.totalAmount,
          currency:           bookings.currency,
          startDate:          bookings.startDate,
          endDate:            bookings.endDate,
          guests:             bookings.guests,
          specialRequests:    bookings.specialRequests,
          cancellationReason: bookings.cancellationReason,
          declineReason:      bookings.declineReason,
          createdAt:          bookings.createdAt,
          listingId:          listings.id,
          listingTitle:       listings.title,
          customerId:         users.id,
          customerEmail:      users.email,
          customerName:       users.fullName,
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
          listing:  { id: r.listingId,  title: r.listingTitle  },
          customer: { id: r.customerId, email: r.customerEmail, fullName: r.customerName },
        },
      });
    } catch (error: any) {
      return reply.code(500).send({ success: false, error: error.message });
    }
  });
}