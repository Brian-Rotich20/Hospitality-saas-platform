// Profile, saved listings, customer dashboard stats; admin customer list.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { guards, requireUser } from '../../app/policies.js';
import { ok } from '../../app/http.js';
import { db } from '../../platform/database/client.js';
import { users } from '../../platform/database/schema/users.js';
import { savedListings } from '../../platform/database/schema/savedListings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { bookings } from '../../platform/database/schema/bookings.js';
import { NotFoundError } from '../../app/errors.js';
import { kenyanPhone } from '../vendors/routes.js';

const profileColumns = { id: true, email: true, fullName: true, phone: true, role: true, avatarUrl: true, verified: true, createdAt: true } as const;
const listingParam = z.object({ listingId: z.string().uuid() });

/** Mounted at /api/users. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/me', { preValidation: guards.user, schema: { tags: ['Users'] } }, async (request) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, requireUser(request).userId), columns: profileColumns });
    if (!user) throw new NotFoundError('User');
    return ok(user);
  });

  app.patch('/me', {
    preValidation: guards.user,
    schema: { tags: ['Users'], body: z.object({ fullName: z.string().trim().min(2).max(100).optional(), phone: kenyanPhone.optional(), avatarUrl: z.string().url().max(500).optional() }) },
  }, async (request) => {
    const [user] = await db.update(users).set({ ...request.body, updatedAt: new Date() }).where(eq(users.id, requireUser(request).userId))
      .returning({ id: users.id, email: users.email, fullName: users.fullName, phone: users.phone, role: users.role, avatarUrl: users.avatarUrl });
    if (!user) throw new NotFoundError('User');
    return ok(user);
  });

  app.get('/me/saved', { preValidation: guards.verifiedUser, schema: { tags: ['Users'] } }, async (request) => {
    const rows = await db.query.savedListings.findMany({
      where: eq(savedListings.userId, requireUser(request).userId),
      with: { listing: { columns: { id: true, title: true, slug: true, coverPhoto: true, location: true, pricingType: true, price: true, minPrice: true, maxPrice: true, currency: true, status: true } } },
      orderBy: [desc(savedListings.createdAt)],
    });
    // Saved listings that are no longer public are omitted.
    return ok(rows.map((r) => r.listing).filter((l) => l.status === 'active'));
  });

  app.post('/me/saved/:listingId', { preValidation: guards.verifiedUser, schema: { tags: ['Users'], params: listingParam } }, async (request) => {
    const userId = requireUser(request).userId;
    const { listingId } = request.params;
    const removed = await db.delete(savedListings).where(and(eq(savedListings.userId, userId), eq(savedListings.listingId, listingId))).returning({ id: savedListings.id });
    if (removed.length) return ok({ saved: false });
    const listing = await db.query.listings.findFirst({ where: and(eq(listings.id, listingId), eq(listings.status, 'active')), columns: { id: true } });
    if (!listing) throw new NotFoundError('Listing');
    await db.insert(savedListings).values({ userId, listingId }).onConflictDoNothing();
    return ok({ saved: true });
  });

  app.get('/me/saved/:listingId', { preValidation: guards.verifiedUser, schema: { tags: ['Users'], params: listingParam } }, async (request) => {
    const row = await db.query.savedListings.findFirst({ where: and(eq(savedListings.userId, requireUser(request).userId), eq(savedListings.listingId, request.params.listingId)), columns: { id: true } });
    return ok({ saved: !!row });
  });

  // Booking counts by status. (The former "spent" figure is gone: LinkMart does not
  // process or know the value of payments between customers and vendors.)
  app.get('/me/stats', { preValidation: guards.verifiedUser, schema: { tags: ['Users'] } }, async (request) => {
    const userId = requireUser(request).userId;
    const counts = await db.select({ status: bookings.status, n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.customerId, userId)).groupBy(bookings.status);
    const [saved] = await db.select({ n: sql<number>`count(*)::int` }).from(savedListings).where(eq(savedListings.userId, userId));
    const by = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>;
    return ok({
      total: counts.reduce((s, c) => s + c.n, 0),
      requested: by.requested ?? 0, accepted: by.accepted ?? 0, completed: by.completed ?? 0,
      declined: by.declined ?? 0, expired: by.expired ?? 0, cancelled: by.cancelled ?? 0,
      savedCount: saved?.n ?? 0,
    });
  });
};

/** Mounted at /api/admin/customers. Accepts `page` (legacy) or `offset`. */
export const customerAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);
  app.get('/', {
    schema: { tags: ['Admin - Customers'], querystring: z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).optional() }) },
  }, async (request) => {
    const { limit } = request.query;
    const offset = request.query.offset ?? ((request.query.page ?? 1) - 1) * limit;
    const rows = await db.select({ id: users.id, fullName: users.fullName, email: users.email, phone: users.phone, avatarUrl: users.avatarUrl, verified: users.verified, banned: users.banned, createdAt: users.createdAt })
      .from(users).where(eq(users.role, 'customer')).orderBy(desc(users.createdAt)).limit(limit).offset(offset);
    return ok(rows);
  });
};
