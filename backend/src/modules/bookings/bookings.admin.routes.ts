// src/modules/bookings/bookings.admin.routes.ts
// ✅ Add admin bookings endpoint

import { FastifyInstance } from 'fastify';
import { db }             from '../../config/database';
import { bookings, listings, users } from '../../db/schema';
import { eq, desc }       from 'drizzle-orm';

export async function bookingAdminRoutes(fastify: FastifyInstance) {

  // GET /api/admin/bookings
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags:        ['Admin - Bookings'],
      description: 'Get all bookings (admin)',
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
      const { status, limit = 50, offset = 0 } = request.query as any;

      const rows = await db
        .select({
          id:          bookings.id,
          status:      bookings.status,
          totalAmount: bookings.totalAmount,
          startDate:   bookings.startDate,
          endDate:     bookings.endDate,
          createdAt:   bookings.createdAt,
          listingId:   bookings.listingId,
          customerId:  bookings.customerId,
          listingTitle: listings.title,
          customerEmail: users.email,
          customerName:  users.fullName,
        })
        .from(bookings)
        .leftJoin(listings, eq(listings.id, bookings.listingId))
        .leftJoin(users,    eq(users.id,     bookings.customerId))
        .where(status ? eq(bookings.status, status) : undefined)
        .limit(Number(limit))
        .offset(Number(offset))
        .orderBy(desc(bookings.createdAt));

      const shaped = rows.map(r => ({
        id:          r.id,
        status:      r.status,
        totalAmount: r.totalAmount,
        startDate:   r.startDate,
        endDate:     r.endDate,
        createdAt:   r.createdAt,
        listing:  { id: r.listingId,   title: r.listingTitle  },
        customer: { id: r.customerId,  email: r.customerEmail, fullName: r.customerName },
      }));

      return reply.send({ success: true, data: shaped });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  });
}