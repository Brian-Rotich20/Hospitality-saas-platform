// src/modules/vendors/vendors.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { VendorService } from './vendors.service';
import { refreshCookieOptions } from '../../utils/cookies';
import {
  vendorApplicationSchema,
  updateVendorSchema,
  payoutDetailsSchema,
} from './vendors.schema';

const vendorService = new VendorService();

export class VendorController {

  // ── POST /vendors/apply ────────────────────────────────────────────────────
  async applyAsVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = vendorApplicationSchema.parse(request.body);
      const vendor = await vendorService.applyAsVendor(userId, body);

      return reply.code(201).send({
        success: true,
        message: 'Vendor application submitted. Check your email for a verification code.',
        data: vendor,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── POST /vendors/verify-email ─────────────────────────────────────────────
  // Returns a fresh accessToken with emailVerified=true so frontend can swap cookies
  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (request as any).user;
      const { otp } = request.body as { otp: string };
      if (!otp) return reply.code(400).send({ success: false, error: 'OTP is required' });

      const result = await vendorService.verifyVendorOTP(user.userId, otp);

       reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.send({
        success: true,
        message: 'Email verified! Your vendor account is now active.',
        data: result,   // { vendor, accessToken } — see vendors.service.ts
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /vendors/resend-otp ───────────────────────────────────────────────
  async resendOTP(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (request as any).user;
      await vendorService.resendOTP(user.userId);
      return reply.send({ success: true, message: 'Verification code sent to your email.' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /vendors/me ────────────────────────────────────────────────────────
  async getMyProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.getVendorProfile(userId);
      return reply.code(200).send({ success: true, data: vendor });
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

  // ── GET /vendors/me/documents ──────────────────────────────────────────────
  async getMyDocuments(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const docs   = await vendorService.getVendorDocuments(userId);
      return reply.code(200).send({ success: true, data: docs });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /vendors/me/documents ─────────────────────────────────────────────
  async uploadVendorDocument(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const { documentType } = request.body as { documentType: string };
      const uploadResult = (request as any).uploadResult;
      const doc = await vendorService.uploadVendorDocument(userId, documentType, uploadResult);
      return reply.code(201).send({ success: true, message: 'Document uploaded successfully', data: doc });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
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
      const vendors = await vendorService.getAllVendors({
        status: status as any,
        limit:  limit  ? parseInt(limit)  : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
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
      const { reason }   = request.body as { reason: string };
      if (!reason?.trim()) return reply.code(422).send({ success: false, error: 'Suspension reason is required' });
      const vendor = await vendorService.suspendVendor(vendorId, reason);
      return reply.code(200).send({ success: true, message: 'Vendor suspended successfully', data: vendor });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}