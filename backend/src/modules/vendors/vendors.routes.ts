// src/modules/vendors/vendors.routes.ts
import { FastifyInstance } from 'fastify';
import { z }               from 'zod';
import { VendorController } from './vendors.controller.js';
import {
  vendorApplicationSchema,
  payoutDetailsSchema,
  updateVendorSchema,
} from './vendors.schema.js';

const vendorController = new VendorController();

export async function vendorRoutes(fastify: FastifyInstance) {

  // ── Apply as vendor ───────────────────────────────────────────────────────
  fastify.post('/apply', {
    preHandler: [fastify.authenticate],
    schema: { body: vendorApplicationSchema, tags: ['Vendors'] },
  }, vendorController.applyAsVendor.bind(vendorController));

  // ── Verify OTP — activates vendor account instantly ───────────────────────
  fastify.post('/verify-email', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Vendors'],
      body: z.object({ otp: z.string().min(6).max(6) }),
    },
  }, vendorController.verifyEmail.bind(vendorController));

  // ── Resend OTP ────────────────────────────────────────────────────────────
  fastify.post('/resend-otp', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'] },
  }, vendorController.resendOTP.bind(vendorController));

  // ── Profile ───────────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'] },
  }, vendorController.getMyProfile.bind(vendorController));

  fastify.put('/me', {
    preHandler: [fastify.authenticate],
    schema: { body: updateVendorSchema, tags: ['Vendors'] },
  }, vendorController.updateMyProfile.bind(vendorController));

  fastify.post('/me/payout-details', {
    preHandler: [fastify.authenticate],
    schema: { body: payoutDetailsSchema, tags: ['Vendors'] },
  }, vendorController.addPayoutDetails.bind(vendorController));

  fastify.post('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'] },
  }, vendorController.uploadVendorDocument.bind(vendorController));

  fastify.get('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'] },
  }, vendorController.getMyDocuments.bind(vendorController));
}

// ── Admin routes ──────────────────────────────────────────────────────────────
const vendorQuerySchema = z.object({
  status: z.enum(['approved', 'suspended']).optional(),
  limit:  z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function vendorAdminRoutes(fastify: FastifyInstance) {
  
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'], querystring: vendorQuerySchema },
  }, vendorController.getAllVendors.bind(vendorController));

  fastify.get('/:vendorId', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'] },
  }, vendorController.getVendorById.bind(vendorController));

  
  fastify.put('/:vendorId/suspend', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'] },
  }, vendorController.suspendVendor.bind(vendorController));
}