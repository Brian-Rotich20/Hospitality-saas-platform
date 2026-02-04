/**
 * ✅ TYPE AUGMENTATION for Fastify decorators
 * 
 * This file MUST be imported before any Fastify usage.
 * Located in server.ts and app.ts at the TOP of imports.
 * 
 * @see server.ts
 * @see app.ts
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Authentication middleware decorator
     * Usage: preHandler: [fastify.authenticate]
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;

    /**
     * Admin role checker middleware decorator
     * Usage: preHandler: [fastify.requireAdmin]
     */
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;

    /**
     * Vendor role checker middleware decorator
     * Usage: preHandler: [fastify.requireVendor]
     */
    requireVendor(request: FastifyRequest, reply: FastifyReply): Promise<void>;

    /**
     * Database instance
     */
    db: any;
  }

  /**
   * Augmented FastifyRequest with user property
   */
  interface FastifyRequest {
    user?: {
      id?: string;
      role?: string;
      email?: string;
      [key: string]: any;
    };
  }
}
