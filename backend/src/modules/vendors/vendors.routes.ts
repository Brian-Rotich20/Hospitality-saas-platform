// src/modules/vendors/vendors.routes.ts
import { FastifyInstance } from 'fastify';
import { z }               from 'zod';
import { VendorController } from './vendors.controller.js';
import { payoutDetailsSchema, updateVendorSchema } from './vendors.schema.js';

const vendorController = new VendorController();

export async function vendorRoutes(fastify: FastifyInstance) {

  // ── Become a vendor — instant, pre-filled, no body ─────────────────────────
  fastify.post('/become', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'] },
  }, vendorController.becomeVendor.bind(vendorController));

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

  // ── Public ────────────────────────────────────────────────────────────────
  fastify.get('/:vendorId', {
    schema: { tags: ['Vendors'] },
  }, vendorController.getPublicProfile.bind(vendorController));
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