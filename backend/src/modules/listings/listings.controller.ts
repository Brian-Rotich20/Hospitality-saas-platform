import { FastifyReply, FastifyRequest } from 'fastify';
import { ListingService } from './listings.service';
import type { 
  CreateListingInput, 
  UpdateListingInput,
  PublishListingInput,
  SearchListingsInput 
} from './listings.schema';

const listingService = new ListingService();

export class ListingController {
  // Create listing
  async createListing(
    request: FastifyRequest<{ Body: CreateListingInput }>,
    reply: FastifyReply
  ) {
    try {
      const userId = (request.user as any).userId;
      
      // Get vendor profile
      const vendor = await request.server.db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found. Please complete vendor registration first.',
        });
      }

      const listing = await listingService.createListing(vendor.id, request.body);

      return reply.code(201).send({
        success: true,
        message: 'Listing created successfully',
        data: listing,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get listing by ID
  async getListingById(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) {
    try {
      const listing = await listingService.getListingById(request.params.id, true);

      return reply.code(200).send({
        success: true,
        data: listing,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get listing by slug
  async getListingBySlug(
    request: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply
  ) {
    try {
      const listing = await listingService.getListingBySlug(request.params.slug);

      return reply.code(200).send({
        success: true,
        data: listing,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Update listing
  async updateListing(
    request: FastifyRequest<{ 
      Params: { id: string };
      Body: UpdateListingInput;
    }>,
    reply: FastifyReply
  ) {
    try {
      const userId = (request.user as any).userId;
      
      const vendor = await request.server.db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const listing = await listingService.updateListing(
        request.params.id,
        vendor.id,
        request.body
      );

      return reply.code(200).send({
        success: true,
        message: 'Listing updated successfully',
        data: listing,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Publish/unpublish listing
  async updateListingStatus(
    request: FastifyRequest<{ 
      Params: { id: string };
      Body: PublishListingInput;
    }>,
    reply: FastifyReply
  ) {
    try {
      const userId = (request.user as any).userId;
      
      const vendor = await request.server.db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const listing = await listingService.updateListingStatus(
        request.params.id,
        vendor.id,
        request.body.status
      );

      return reply.code(200).send({
        success: true,
        message: `Listing ${request.body.status === 'active' ? 'published' : 'paused'} successfully`,
        data: listing,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Delete listing
  async deleteListing(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) {
    try {
      const userId = (request.user as any).userId;
      
      const vendor = await request.server.db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      await listingService.deleteListing(request.params.id, vendor.id);

      return reply.code(200).send({
        success: true,
        message: 'Listing deleted successfully',
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Search listings
  async searchListings(
    request: FastifyRequest<{ Querystring: SearchListingsInput }>,
    reply: FastifyReply
  ) {
    try {
      const listings = await listingService.searchListings(request.query);

      return reply.code(200).send({
        success: true,
        data: listings,
        count: listings.length,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get my listings
  async getMyListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      
      const vendor = await request.server.db.query.vendors.findFirst({
        where: (vendors, { eq }) => eq(vendors.userId, userId),
      });

      if (!vendor) {
        return reply.code(403).send({
          success: false,
          error: 'Vendor profile not found',
        });
      }

      const listings = await listingService.getMyListings(vendor.id);

      return reply.code(200).send({
        success: true,
        data: listings,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get featured listings
  async getFeaturedListings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const listings = await listingService.getFeaturedListings(10);

      return reply.code(200).send({
        success: true,
        data: listings,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}