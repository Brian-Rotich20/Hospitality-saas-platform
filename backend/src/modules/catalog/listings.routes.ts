import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { guards, optionalAuth, requireVendorCtx } from '../../app/policies.js';
import { idParams, ok } from '../../app/http.js';
import { listingsService } from './listings.service.js';
import {
  createListingSchema, listingStatusSchema, searchListingsSchema, updateListingSchema,
  listingResponse, listingListResponse, listingSearchResponse,
} from './listings.schema.js';
import { vendorsRepo } from '../vendors/repo.js';
import { missingContact } from '../vendors/contact.js';
import { z } from 'zod';

/** Mounted at /api/listings. Static paths are registered before /:id. */
export const listingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', { schema: { tags: ['Listings'], querystring: searchListingsSchema, response: { 200: listingSearchResponse } } }, async (request) => {
    const { items, total } = await listingsService.search(request.query);
    return ok(items, { count: items.length, total });
  });

  app.get('/featured', { schema: { tags: ['Listings'], response: { 200: listingListResponse } } }, async () => ok(await listingsService.featured(10)));

  app.get('/slug/:slug', { schema: { tags: ['Listings'], params: z.object({ slug: z.string().min(1).max(300) }), response: { 200: listingResponse } } },
    async (request) => ok(await listingsService.getBySlug(request.params.slug)));

  app.get('/me', { preValidation: guards.vendor, schema: { tags: ['Listings'], response: { 200: listingListResponse } } },
    async (request) => ok(await listingsService.mine(requireVendorCtx(request).vendor.id)));

  app.get('/:id', { preValidation: optionalAuth, schema: { tags: ['Listings'], params: idParams, response: { 200: listingResponse } } }, async (request) => {
    const viewer = request.auth?.role === 'vendor' ? await vendorsRepo.findByUserId(request.auth.userId) : undefined;
    return ok(await listingsService.getById(request.params.id, viewer?.id));
  });

  // Drafts can be created and edited by any non-suspended vendor; publishing additionally
  // requires an entitled subscription (checked in the service).
  app.post('/', { preValidation: guards.activeVendor, schema: { tags: ['Listings'], body: createListingSchema, response: { 201: listingResponse } } }, async (request, reply) => {
    reply.code(201);
    return ok(await listingsService.create(requireVendorCtx(request).vendor.id, request.body), { message: 'Listing created as a draft' });
  });

  app.put('/:id', { preValidation: guards.activeVendor, schema: { tags: ['Listings'], params: idParams, body: updateListingSchema, response: { 200: listingResponse } } },
    async (request) => ok(await listingsService.update(request.params.id, requireVendorCtx(request).vendor.id, request.body), { message: 'Listing updated' }));

  app.patch('/:id/status', { preValidation: guards.activeVendor, schema: { tags: ['Listings'], params: idParams, body: listingStatusSchema, response: { 200: listingResponse } } },
    async (request) => {
      const { vendor, entitlement } = requireVendorCtx(request);
      const row = await listingsService.setStatus(request.params.id, vendor.id, request.body.status, entitlement.entitled, missingContact(vendor));
      return ok(row, { message: request.body.status === 'active' ? 'Listing published' : 'Listing paused' });
    });

  app.delete('/:id', { preValidation: guards.vendor, schema: { tags: ['Listings'], params: idParams } }, async (request) => {
    await listingsService.remove(request.params.id, requireVendorCtx(request).vendor.id);
    return ok(null, { message: 'Listing deleted' });
  });
};
