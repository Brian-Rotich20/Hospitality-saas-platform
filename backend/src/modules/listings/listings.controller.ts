import { FastifyReply, FastifyRequest } from 'fastify';
import { ListingService } from './listings.service';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import { eq } from 'drizzle-orm';
import {
  createListingSchema,
  updateListingSchema,
  publishListingSchema,
  searchListingsSchema,
} from './listings.schema';

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
  return vendor;
}

export class ListingController {

  // ── POST /listings ────────────────────────────────────────────────────────────
  async createListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      const body = createListingSchema.parse(request.body);
      const listing = await listingService.createListing(vendor.id, body);

      return reply.code(201).send({
        success: true,
        message: 'Listing created successfully',
        data: listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /listings/:id ─────────────────────────────────────────────────────────
  async getListingById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const listing = await listingService.getListingById(id, true);
      return reply.code(200).send({ success: true, data: listing });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── GET /listings/slug/:slug ──────────────────────────────────────────────────
  async getListingBySlug(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { slug } = request.params as { slug: string };
      const listing = await listingService.getListingBySlug(slug);
      return reply.code(200).send({ success: true, data: listing });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PUT /listings/:id ─────────────────────────────────────────────────────────
  async updateListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      const body = updateListingSchema.parse(request.body);
      const listing = await listingService.updateListing(id, vendor.id, body);

      return reply.code(200).send({
        success: true,
        message: 'Listing updated successfully',
        data: listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── PUT /listings/:id/status
  async updateListingStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      const { status } = publishListingSchema.parse(request.body);
      const listing = await listingService.updateListingStatus(id, vendor.id, status);

      return reply.code(200).send({
        success: true,
        message: `Listing ${status === 'active' ? 'published' : 'paused'} successfully`,
        data: listing,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── DELETE /listings/:id
  async deleteListing(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const userId = (request.user as any).userId;
      const vendor = await resolveVendor(userId, reply);
      if (!vendor) return;

      await listingService.deleteListing(id, vendor.id);
      return reply.code(200).send({ success: true, message: 'Listing deleted successfully' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /listings (public search)
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

  // ── GET /listings/me/listings 
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

  // ── GET /listings/featured 
  async getFeaturedListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const results = await listingService.getFeaturedListings(10);
      return reply.code(200).send({ success: true, data: results });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}