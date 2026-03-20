// src/modules/vendors/vendors.routes.ts
// ✅ Remove schema: { body: vendorReviewSchema } from the review route
// Fastify-type-provider-zod fails when schema has circular imports
// We validate manually in the controller instead

import { FastifyInstance } from 'fastify';
import { VendorController } from './vendors.controller';
import {
  vendorApplicationSchema,
  payoutDetailsSchema,
  updateVendorSchema,
} from './vendors.schema';

const vendorController = new VendorController();

export async function vendorRoutes(fastify: FastifyInstance) {
  fastify.post('/apply', {
    preHandler: [fastify.authenticate],
    schema: {
      body: vendorApplicationSchema,
      tags: ['Vendors'],
      description: 'Apply as a vendor',
    },
  }, vendorController.applyAsVendor.bind(vendorController));

  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'], description: 'Get my vendor profile' },
  }, vendorController.getMyProfile.bind(vendorController));

  fastify.put('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      body: updateVendorSchema,
      tags: ['Vendors'],
      description: 'Update my vendor profile',
    },
  }, vendorController.updateMyProfile.bind(vendorController));

  fastify.post('/me/payout-details', {
    preHandler: [fastify.authenticate],
    schema: {
      body: payoutDetailsSchema,
      tags: ['Vendors'],
      description: 'Add/update payout details',
    },
  }, vendorController.addPayoutDetails.bind(vendorController));

  fastify.post('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'], description: 'Upload vendor document' },
  }, vendorController.uploadVendorDocument.bind(vendorController));

  fastify.get('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Vendors'], description: 'Get my documents' },
  }, vendorController.getMyDocuments.bind(vendorController));
}

export async function vendorAdminRoutes(fastify: FastifyInstance) {
  fastify.get('/pending', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'], description: 'Get pending vendor applications' },
  }, vendorController.getPendingVendors.bind(vendorController));

  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Vendors'],
      description: 'Get all vendors',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit:  { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
  }, vendorController.getAllVendors.bind(vendorController));

  fastify.get('/:vendorId', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'], description: 'Get vendor by ID' },
  }, vendorController.getVendorById.bind(vendorController));

  // ✅ NO body schema here — validate manually in controller
  // Removing schema: { body: vendorReviewSchema } fixes FST_ERR_VALIDATION
  fastify.put('/:vendorId/review', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'], description: 'Approve or reject vendor' },
  }, vendorController.reviewVendor.bind(vendorController));

  fastify.put('/:vendorId/suspend', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Admin - Vendors'], description: 'Suspend vendor account' },
  }, vendorController.suspendVendor.bind(vendorController));
}