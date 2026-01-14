import { FastifyReply, FastifyRequest } from 'fastify';
import { PayoutService } from './payouts.service';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import { eq } from 'drizzle-orm';

const payoutService = new PayoutService();

export class PayoutController {
  // Get my payouts (vendor)
  async getMyPayouts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const payouts = await payoutService.getVendorPayouts(vendor.id, request.query);

      return reply.code(200).send({
        success: true,
        data: payouts,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get earnings summary (vendor)
  async getMyEarnings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;

      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const earnings = await payoutService.getVendorEarnings(vendor.id);

      return reply.code(200).send({
        success: true,
        data: earnings,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Get all payouts
  async getAllPayouts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const payouts = await payoutService.getAllPayouts(request.query);

      return reply.code(200).send({
        success: true,
        data: payouts,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Trigger manual payout
  async triggerManualPayout(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;

      const payout = await payoutService.triggerManualPayout(id);

      return reply.code(200).send({
        success: true,
        message: 'Payout processed successfully',
        data: payout,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Admin: Process scheduled payouts (cron endpoint)
  async processScheduledPayouts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const results = await payoutService.processScheduledPayouts();

      return reply.code(200).send({
        success: true,
        message: `Processed ${results.length} payouts`,
        data: results,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}