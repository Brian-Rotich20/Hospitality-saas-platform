// src/modules/users/users.routes.ts
import { FastifyInstance } from 'fastify';
import { z }              from 'zod';
import { UserService }    from './users.service.js';

const userService = new UserService();

const updateProfileSchema = z.object({
  fullName:  z.string().min(2).max(100).optional(),
  phone:     z.string().min(7).max(20).optional(),
  avatarUrl: z.string().url().optional(),
});

export async function userRoutes(fastify: FastifyInstance) {

  // GET /api/users/me — get own profile
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const user = (req as any).user;
    const profile = await userService.getProfile(user.userId);
    return reply.send({ success: true, data: profile });
  });

  // PATCH /api/users/me — update profile
  fastify.patch('/me', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const user   = (req as any).user;
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const updated = await userService.updateProfile(user.userId, parsed.data);
    return reply.send({ success: true, data: updated });
  });

  // GET /api/users/me/saved — get saved listings
  fastify.get('/me/saved', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user = (req as any).user;
    const saved = await userService.getSavedListings(user.userId);
    return reply.send({ success: true, data: saved });
  });

  // POST /api/users/me/saved/:listingId — toggle save
  fastify.post('/me/saved/:listingId', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user      = (req as any).user;
    const { listingId } = req.params as { listingId: string };
    const result    = await userService.toggleSaved(user.userId, listingId);
    return reply.send({ success: true, data: result });
  });

  // GET /api/users/me/saved/:listingId — check if saved
  fastify.get('/me/saved/:listingId', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user      = (req as any).user;
    const { listingId } = req.params as { listingId: string };
    const result    = await userService.isSaved(user.userId, listingId);
    return reply.send({ success: true, data: result });
  });

  // GET /api/users/me/stats — dashboard stats
  fastify.get('/me/stats', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user  = (req as any).user;
    const stats = await userService.getCustomerStats(user.userId);
    return reply.send({ success: true, data: stats });
  });
}