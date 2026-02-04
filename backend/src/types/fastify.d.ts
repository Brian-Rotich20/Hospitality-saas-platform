import 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireVendor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    db: any;
  }

  interface FastifyRequest {
    user: {
      id?: string;
      role?: string;
      email?: string;
      [key: string]: any;
    } | undefined;
  }
}

export {};