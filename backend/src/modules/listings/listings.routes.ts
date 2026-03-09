import { FastifyInstance } from 'fastify';
import { ListingController } from './listings.controller';

const listingController = new ListingController();

export async function listingRoutes(fastify: FastifyInstance) {

  // ── Public routes — static MUST come before /:id ──────────────────────────

  fastify.get('/', {
    schema: { tags: ['Listings'], description: 'Search and browse listings' },
  }, listingController.searchListings.bind(listingController));

  fastify.get('/featured', {
    schema: { tags: ['Listings'], description: 'Get featured listings' },
  }, listingController.getFeaturedListings.bind(listingController));

  // ✅ Static path before /:id — otherwise Fastify matches 'slug' as :id
  fastify.get('/slug/:slug', {
    schema: { tags: ['Listings'], description: 'Get listing by slug' },
  }, listingController.getListingBySlug.bind(listingController));

  // ✅ Static path before /:id — otherwise Fastify matches 'me' as :id
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Listings'], description: 'Get my listings' },
  }, listingController.getMyListings.bind(listingController));

  // ── Dynamic route — always LAST among GETs ────────────────────────────────
  fastify.get('/:id', {
    schema: { tags: ['Listings'], description: 'Get listing by ID' },
  }, listingController.getListingById.bind(listingController));

  // ── Vendor routes (authenticated) ─────────────────────────────────────────

  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Listings'], description: 'Create new listing' },
  }, listingController.createListing.bind(listingController));

  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Listings'], description: 'Update listing' },
  }, listingController.updateListing.bind(listingController));

  fastify.put('/:id/status', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Listings'], description: 'Publish or pause listing' },
  }, listingController.updateListingStatus.bind(listingController));

  fastify.delete('/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Listings'], description: 'Delete listing' },
  }, listingController.deleteListing.bind(listingController));
}