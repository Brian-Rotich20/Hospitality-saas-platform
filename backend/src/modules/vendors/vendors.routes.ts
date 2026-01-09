import { FastifyInstance } from 'fastify';
import { VendorController } from './vendors.controller';
import z from 'zod';
import {
  vendorApplicationSchema,
  payoutDetailsSchema,
  updateVendorSchema,
  vendorReviewSchema,
} from './vendors.schema';
import { zodToJsonSchema } from 'zod-to-json-schema';

const vendorController = new VendorController();

export async function vendorRoutes(fastify: FastifyInstance) {
  // Apply as vendor
  fastify.post('/apply', {
    preHandler: [fastify.authenticate],
    schema: {
      body: zodToJsonSchema(vendorApplicationSchema, {
        name: 'VendorApplication',
      }),
      tags: ['Vendors'],
      description: 'Apply as a vendor',
    },
  }, vendorController.applyAsVendor.bind(vendorController));

  // Get my vendor profile
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Vendors'],
      description: 'Get my vendor profile',
    },
  }, vendorController.getMyProfile.bind(vendorController));

  // Update vendor profile
  fastify.put('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      body: zodToJsonSchema(updateVendorSchema, {
        name: 'UpdateVendorProfile',
      }),
      tags: ['Vendors'],
      description: 'Update my vendor profile',
    },
  }, vendorController.updateMyProfile.bind(vendorController));

  // Add/update payout details
  fastify.post('/me/payout-details', {
    preHandler: [fastify.authenticate],
    schema: {
      body: zodToJsonSchema(payoutDetailsSchema, {
        name: 'VendorPayoutDetails',
      }),
      tags: ['Vendors'],
      description: 'Add/update payout details',
    },
  }, vendorController.addPayoutDetails.bind(vendorController));

  // Upload documents (multipart → no body schema)
  fastify.post('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Vendors'],
      description: 'Upload vendor document',
    },
  }, vendorController.uploadDocument.bind(vendorController));

  fastify.get('/me/documents', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Vendors'],
      description: 'Get my documents',
    },
  }, vendorController.getMyDocuments.bind(vendorController));
}

export async function vendorAdminRoutes(fastify: FastifyInstance) {
  // Get pending vendors
  fastify.get('/pending', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Vendors'],
      description: 'Get all pending vendor applications',
    },
  }, vendorController.getPendingVendors.bind(vendorController));

  // Get all vendors
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Vendors'],
      description: 'Get all vendors with filters',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          businessType: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
  }, vendorController.getAllVendors.bind(vendorController));

  // Get vendor by ID
  fastify.get('/:vendorId', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Vendors'],
      description: 'Get vendor by ID',
      params: {
        type: 'object',
        required: ['vendorId'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, vendorController.getVendorById.bind(vendorController));

  // Review vendor
  fastify.put('/:vendorId/review', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: zodToJsonSchema(vendorReviewSchema, {
        name: 'VendorReview',
      }),
      params: {
        type: 'object',
        required: ['vendorId'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' },
        },
      },
      tags: ['Admin - Vendors'],
      description: 'Approve or reject vendor application',
    },
  }, vendorController.reviewVendor.bind(vendorController));

  // Suspend vendor
  fastify.put('/:vendorId/suspend', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['vendorId'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 10 },
        },
      },
      tags: ['Admin - Vendors'],
      description: 'Suspend vendor account',
    },
  }, vendorController.suspendVendor.bind(vendorController));
}
