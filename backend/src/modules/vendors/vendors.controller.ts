// src/modules/vendors/vendors.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { VendorService } from './vendors.service.js';
import { updateVendorSchema, payoutDetailsSchema } from './vendors.schema.js';
import { VendorFilters } from './vendors.types.js'

const vendorService = new VendorService();

export class VendorController {

  // ── POST /vendors/become ───────────────────────────────────────────────────
  // No body needed — pre-fills from the user's own name/phone, instant, idempotent.
  async becomeVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.becomeVendor(userId);
      return reply.code(201).send({ success: true, message: 'You are now a seller', data: vendor });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /vendors/me ────────────────────────────────────────────────────────
  async getMyProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.getVendorProfile(userId);
      const { complete, missing } = vendorService.isProfileComplete(vendor);
      return reply.code(200).send({ success: true, data: { ...vendor, profileComplete: complete, missing } });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PUT /vendors/me ────────────────────────────────────────────────────────
  async updateMyProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = updateVendorSchema.parse(request.body);
      const vendor = await vendorService.updateVendorProfile(userId, body);
      return reply.code(200).send({ success: true, message: 'Profile updated successfully', data: vendor });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── POST /vendors/me/payout-details ───────────────────────────────────────
  async addPayoutDetails(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = payoutDetailsSchema.parse(request.body);
      const vendor = await vendorService.addPayoutDetails(userId, body);
      return reply.code(200).send({ success: true, message: 'Payout details saved', data: vendor });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /vendors/:vendorId (public) ───────────────────────────────────────
  async getPublicProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const vendor = await vendorService.getPublicVendorProfile(vendorId);
      return reply.code(200).send({ success: true, data: vendor });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── Admin routes ───────────────────────────────────────────────────────────

  async getAllVendors(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { status, limit, offset } = request.query as { status?: string; limit?: string; offset?: string };

      const filters : VendorFilters ={
        status: status as any
      }
       if (limit) filters.limit = parseInt(limit);
       if (offset) filters.offset = parseInt(offset);

      const vendors = await vendorService.getAllVendors(filters);

      return reply.code(200).send({ success: true, data: vendors });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  async getVendorById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const vendor = await vendorService.getVendorById(vendorId);
      return reply.code(200).send({ success: true, data: vendor });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  async suspendVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const vendor = await vendorService.suspendVendor(vendorId);
      return reply.code(200).send({ success: true, message: 'Vendor suspended successfully', data: vendor });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}