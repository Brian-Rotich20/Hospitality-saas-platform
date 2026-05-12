import { FastifyRequest, FastifyReply } from 'fastify';
import { VendorService } from './vendors.service';
import {
  vendorApplicationSchema,
  updateVendorSchema,
  payoutDetailsSchema,
  vendorReviewSchema,
} from './vendors.schema';

const vendorService = new VendorService();

export class VendorController {

  // ── POST /vendors/apply ───────────────────────────────────────────────────────
  async applyAsVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = vendorApplicationSchema.parse(request.body);
      const vendor = await vendorService.applyAsVendor(userId, body);

      return reply.code(201).send({
        success: true,
        message: 'Vendor application submitted. You will be notified once reviewed.',
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

  // ── GET /vendors/me ───────────────────────────────────────────────────────────
  async getMyProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await vendorService.getVendorProfile(userId);
      return reply.code(200).send({ success: true, data: vendor });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PUT /vendors/me ───────────────────────────────────────────────────────────
  async updateMyProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = updateVendorSchema.parse(request.body);
      const vendor = await vendorService.updateVendorProfile(userId, body);

      return reply.code(200).send({
        success: true,
        message: 'Profile updated successfully',
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

  // ── POST /vendors/me/payout-details ──────────────────────────────────────────
  async addPayoutDetails(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body   = payoutDetailsSchema.parse(request.body);
      const vendor = await vendorService.addPayoutDetails(userId, body);

      return reply.code(200).send({
        success: true,
        message: 'Payout details saved successfully',
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

  // ── GET /vendors/me/documents ─────────────────────────────────────────────────
  async getMyDocuments(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const docs   = await vendorService.getVendorDocuments(userId);
      return reply.code(200).send({ success: true, data: docs });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /vendors/:vendorId (public profile) ───────────────────────────────────
  async getPublicProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const vendor = await vendorService.getPublicVendorProfile(vendorId);
      return reply.code(200).send({ success: true, data: vendor });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── Admin: GET /admin/vendors/pending ─────────────────────────────────────────
  async getPendingVendors(request: FastifyRequest, reply: FastifyReply) {
    try {
      const vendors = await vendorService.getPendingVendors();
      return reply.code(200).send({ success: true, data: vendors });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── Admin: GET /admin/vendors ─────────────────────────────────────────────────
  async getAllVendors(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { status, limit, offset } = request.query as {
        status?: string;
        limit?:  string;
        offset?: string;
      };

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

  // ── Admin: GET /admin/vendors/:vendorId ───────────────────────────────────────
  async getVendorById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const vendor = await vendorService.getVendorById(vendorId);
      return reply.code(200).send({ success: true, data: vendor });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── Admin: PUT /admin/vendors/:vendorId/review ────────────────────────────────
  async reviewVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const adminId      = (request.user as any).userId;

      // ✅ Manual validation — no Zod schema on route to avoid FST_ERR_VALIDATION
      const body = request.body as any;
      const status = body?.status;
      const rejectionReason = body?.rejectionReason;

      if (!status || !['approved', 'rejected'].includes(status)) {
        return reply.code(422).send({
          success: false,
          error: 'status must be "approved" or "rejected"',
        });
      }

      if (status === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 10)) {
        return reply.code(422).send({
          success: false,
          error: 'rejectionReason must be at least 10 characters when rejecting',
        });
      }

      const vendor = await vendorService.reviewVendorApplication(
        vendorId, adminId, { status, rejectionReason }
      );

      return reply.code(200).send({
        success: true,
        message: `Vendor ${status} successfully`,
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  async uploadVendorDocument(request: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = (request.user as any).userId;
    const { documentType } = request.body as { documentType: string };
    const uploadResult = (request as any).uploadResult; // set by upload middleware

    const doc = await vendorService.uploadVendorDocument(userId, documentType, uploadResult);

    return reply.code(201).send({
      success: true,
      message: 'Document uploaded successfully',
      data: doc,
    });
  } catch (error: any) {
    return reply.code(400).send({ success: false, error: error.message });
  }
}

  // ── Admin: PUT /admin/vendors/:vendorId/suspend ───────────────────────────────
  async suspendVendor(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const { reason }   = request.body as { reason: string };

      if (!reason?.trim()) {
        return reply.code(422).send({
          success: false,
          error: 'Suspension reason is required',
        });
      }

      const vendor = await vendorService.suspendVendor(vendorId, reason);
      return reply.code(200).send({
        success: true,
        message: 'Vendor suspended successfully',
        data: vendor,
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (request as any).user;
      const { otp } = request.body as { otp: string };
      if (!otp) return reply.code(400).send({ success: false, error: 'OTP is required' });
 
      const vendor = await vendorService.verifyVendorOTP(user.userId, otp);
      return reply.send({ success: true, data: vendor, message: 'Email verified! Your vendor account is now active.' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
 
  async resendOTP(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (request as any).user;
      await vendorService.resendOTP(user.userId);
      return reply.send({ success: true, message: 'Verification code sent to your email.' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}

