import { FastifyRequest, FastifyReply } from 'fastify';
import { BookingService } from './bookings.service';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import {
  createBookingSchema,
  declineBookingSchema,
  cancelBookingSchema,
  getBookingsSchema,
} from './bookings.schema';

const bookingService = new BookingService();

// ── Shared helper — resolves vendorId from authenticated userId ───────────────
async function resolveVendor(userId: string, reply: FastifyReply) {
  const vendor = await db.query.vendors.findFirst({
    where: eq(vendors.userId, userId),
  });
  if (!vendor) {
    reply.code(403).send({ success: false, error: 'Vendor profile not found' });
    return null;
  }
  return vendor;
}

export class BookingController {

  // ── POST /bookings ────────────────────────────────────────────────────────────
  async createBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const role   = (request.user as any).role;

      if (role !== 'customer') {
        return reply.code(403).send({ success: false, error: 'Only customers can create bookings' });
      }

      const body    = createBookingSchema.parse(request.body);
      const booking = await bookingService.createBooking(userId, body);

      return reply.code(201).send({
        success: true,
        message: 'Booking request created successfully',
        data: booking,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /bookings/:id ─────────────────────────────────────────────────────────
  async getBookingById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }   = request.params as { id: string };
      const userId   = (request.user as any).userId;
      const role     = (request.user as any).role;
      const booking  = await bookingService.getBookingById(id, userId, role);
      return reply.code(200).send({ success: true, data: booking });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PATCH /bookings/:id/accept (vendor) ───────────────────────────────────────
  async acceptBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const vendor = await resolveVendor((request.user as any).userId, reply);
      if (!vendor) return;

      const booking = await bookingService.acceptBooking(id, vendor.id);
      return reply.code(200).send({ success: true, message: 'Booking accepted', data: booking });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── PATCH /bookings/:id/decline (vendor) ──────────────────────────────────────
  async declineBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const vendor = await resolveVendor((request.user as any).userId, reply);
      if (!vendor) return;

      const body    = declineBookingSchema.parse(request.body);
      const booking = await bookingService.declineBooking(id, vendor.id, body);
      return reply.code(200).send({ success: true, message: 'Booking declined', data: booking });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── PATCH /bookings/:id/cancel (customer) ─────────────────────────────────────
  async cancelBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }  = request.params as { id: string };
      const userId  = (request.user as any).userId;
      const body    = cancelBookingSchema.parse(request.body);
      const booking = await bookingService.cancelBooking(id, userId, body);
      return reply.code(200).send({ success: true, message: 'Booking cancelled', data: booking });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /bookings/me (customer) ───────────────────────────────────────────────
  async getMyBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId  = (request.user as any).userId;
      const filters = getBookingsSchema.parse(request.query);
      const data    = await bookingService.getCustomerBookings(userId, filters);
      return reply.code(200).send({ success: true, data, count: data.length });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /bookings/vendor (vendor) ─────────────────────────────────────────────
  async getVendorBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const vendor  = await resolveVendor((request.user as any).userId, reply);
      if (!vendor) return;

      const filters = getBookingsSchema.parse(request.query);
      const data    = await bookingService.getVendorBookings(vendor.id, filters);
      return reply.code(200).send({ success: true, data, count: data.length });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /bookings/vendor/pending (vendor dashboard) ───────────────────────────
  async getPendingBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const vendor = await resolveVendor((request.user as any).userId, reply);
      if (!vendor) return;

      const data = await bookingService.getPendingBookings(vendor.id);
      return reply.code(200).send({ success: true, data, count: data.length });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}