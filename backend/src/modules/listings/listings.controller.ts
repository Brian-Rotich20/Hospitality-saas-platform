import { FastifyReply, FastifyRequest } from 'fastify';
import { ListingService } from './listings.service.js';
import { db }            from '../../config/database.js';
import { eq }            from 'drizzle-orm';

// ✅ Direct import — avoids circular dependency / FST_ERR_VALIDATION
import { vendors } from '../../db/schema/vendors.js';

import {
  createListingSchema,
  updateListingSchema,
  publishListingSchema,
  searchListingsSchema,
} from './listings.schema.js';

const listingService = new ListingService();

// ── Helper: resolve vendor from authenticated user ────────────────────────────
async function resolveVendor(userId: string, reply: FastifyReply) {
  const vendor = await db.query.vendors.findFirst({
    where: eq(vendors.userId, userId),
  });
  if (!vendor) {
    reply.code(403).send({
      success: false,
      error: 'Vendor profile not found. Please complete vendor registration first.',
    });
    return null;
  }
  if (vendor.status !== 'approved') {
    reply.code(403).send({
      success: false,
      error: 'Your vendor account is pending approval. Please wait for admin review.',
    });
    return null;
  }
  return vendor;
}

export class ListingController {

  // ── POST /listings ────────────────────────────────────────────────────────
  async createListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      let body;
        try {
          body = createListingSchema.parse(request.body);
        } catch (zodErr: any) {
          request.log.error({ zodErrors: zodErr.errors }, 'Zod validation failed');
          return reply.code(422).send({
            success: false,
            error: zodErr.errors,  // This will show EXACTLY which field is failing
          });
        }
      const listing = await listingService.createListing(vendor.id, body);

      return reply.code(201).send({
        success: true,
        message: 'Listing created successfully',
        data:    listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /listings/:id ─────────────────────────────────────────────────────
  async getListingById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }  = request.params as { id: string };
      const listing = await listingService.getListingById(id);
      return reply.code(200).send({ success: true, data: listing });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── GET /listings/slug/:slug ──────────────────────────────────────────────
  async getListingBySlug(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { slug } = request.params as { slug: string };
      const listing  = await listingService.getListingBySlug(slug);
      return reply.code(200).send({ success: true, data: listing });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PUT /listings/:id ─────────────────────────────────────────────────────
  async updateListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }  = request.params as { id: string };
      const userId  = (request.user as any).userId;
      const vendor  = await resolveVendor(userId, reply);
      if (!vendor) return;

      const body    = updateListingSchema.parse(request.body);
      const listing = await listingService.updateListing(id, vendor.id, body);

      return reply.code(200).send({
        success: true,
        message: 'Listing updated successfully',
        data:    listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── PATCH /listings/:id/status (also PUT for compat) ─────────────────────
  async updateListingStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }  = request.params as { id: string };
      const userId  = (request.user as any).userId;
      const vendor  = await resolveVendor(userId, reply);
      if (!vendor) return;

      const { status } = publishListingSchema.parse(request.body);
      const listing    = await listingService.updateListingStatus(id, vendor.id, status);

      return reply.code(200).send({
        success: true,
        message: `Listing ${status === 'active' ? 'published' : 'paused'} successfully`,
        data:    listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── DELETE /listings/:id ──────────────────────────────────────────────────
  async deleteListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }  = request.params as { id: string };
      const userId  = (request.user as any).userId;
      const vendor  = await resolveVendor(userId, reply);
      if (!vendor) return;

      await listingService.deleteListing(id, vendor.id);
      return reply.code(200).send({ success: true, message: 'Listing deleted successfully' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /listings (public search) ─────────────────────────────────────────
  async searchListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const filters = searchListingsSchema.parse(request.query);
      const results = await listingService.searchListings(filters);
      return reply.code(200).send({
        success: true,
        data:    results,
        count:   results.length,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
        cause: error?.cause?.message ?? error?.cause ?? 'no cause',
      });
    }
  }

  // ── GET /listings/me ──────────────────────────────────────────────────────
  async getMyListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      const results = await listingService.getMyListings(vendor.id);
      return reply.code(200).send({ success: true, data: results });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /listings/featured ────────────────────────────────────────────────
  async getFeaturedListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const results = await listingService.getFeaturedListings(10);
      return reply.code(200).send({ success: true, data: results });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}