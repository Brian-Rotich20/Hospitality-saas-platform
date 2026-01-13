import { FastifyReply, FastifyRequest } from 'fastify';
import { AvailabilityService } from './availability.service';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import { eq } from 'drizzle-orm';

const availabilityService = new AvailabilityService();

export class AvailabilityController {
  // Block dates
  async blockDates(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { listingId } = request.params as any;
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

      const result = await availabilityService.blockDates(listingId, vendor.id, request.body as any);

      return reply.code(200).send({
        success: true,
        message: `${result.length} date(s) blocked successfully`,
        data: result,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Unblock dates
  async unblockDates(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { listingId } = request.params as any;
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

      const result = await availabilityService.unblockDates(listingId, vendor.id, request.body as any);

      return reply.code(200).send({
        success: true,
        message: `${result.length} date(s) unblocked successfully`,
        data: result,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Check availability
  async checkAvailability(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { listingId } = request.params as any;
      const { startDate, endDate } = request.query as any;

      const isAvailable = await availabilityService.checkAvailability(listingId, startDate, endDate);

      return reply.code(200).send({
        success: true,
        data: {
          available: isAvailable,
          listingId,
          startDate,
          endDate,
        },
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get calendar
  async getCalendar(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { listingId } = request.params as any;
      const { startDate, endDate } = request.query as any;

      const calendar = await availabilityService.getCalendar(listingId, startDate, endDate);

      return reply.code(200).send({
        success: true,
        data: calendar,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}