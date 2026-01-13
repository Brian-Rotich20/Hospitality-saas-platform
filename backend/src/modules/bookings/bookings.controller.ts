import { FastifyReply, FastifyRequest } from 'fastify';
import { BookingService } from './bookings.service';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import { eq } from 'drizzle-orm';

const bookingService = new BookingService();

export class BookingController {
  // Create booking - REMOVE TYPE ANNOTATIONS
  async createBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const role = (request.user as any).role;

      if (role !== 'customer') {
        return reply.code(403).send({
          success: false,
          error: 'Only customers can create bookings',
        });
      }

      const booking = await bookingService.createBooking(userId, request.body as any);

      return reply.code(201).send({
        success: true,
        message: 'Booking request created successfully',
        data: booking,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get booking by ID
  async getBookingById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;
      const userId = (request.user as any).userId;
      const role = (request.user as any).role;

      const booking = await bookingService.getBookingById(id, userId, role);

      return reply.code(200).send({
        success: true,
        data: booking,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Accept booking (vendor)
  async acceptBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const booking = await bookingService.acceptBooking(id, vendor.id);

      return reply.code(200).send({
        success: true,
        message: 'Booking accepted successfully',
        data: booking,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Decline booking (vendor)
  async declineBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const booking = await bookingService.declineBooking(id, vendor.id, request.body as any);

      return reply.code(200).send({
        success: true,
        message: 'Booking declined',
        data: booking,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Cancel booking (customer)
  async cancelBooking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;
      const userId = (request.user as any).userId;

      const booking = await bookingService.cancelBooking(id, userId, request.body as any);

      return reply.code(200).send({
        success: true,
        message: 'Booking cancelled successfully',
        data: booking,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get my bookings (customer)
  async getMyBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;

      const bookings = await bookingService.getCustomerBookings(userId, request.query as any);

      return reply.code(200).send({
        success: true,
        data: bookings,
        count: bookings.length,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get vendor bookings
  async getVendorBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const bookings = await bookingService.getVendorBookings(vendor.id, request.query as any);

      return reply.code(200).send({
        success: true,
        data: bookings,
        count: bookings.length,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get pending bookings (vendor dashboard)
  async getPendingBookings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const bookings = await bookingService.getPendingBookings(vendor.id);

      return reply.code(200).send({
        success: true,
        data: bookings,
        count: bookings.length,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}