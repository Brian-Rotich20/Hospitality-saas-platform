import 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Authentication preHandler decorator added in `app.ts` via `fastify.decorate('authenticate', authenticate)`
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

    /**
     * Admin-check preHandler decorator
     */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

    /**
     * Vendor-check preHandler decorator
     */
    requireVendor: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
  }

  // Optionally type `request.user` populated by `@fastify/jwt`
  interface FastifyRequest {
    user?: {
      id?: string;
      role?: string;
      email?: string;
      [key: string]: any;
    };
  }
}
