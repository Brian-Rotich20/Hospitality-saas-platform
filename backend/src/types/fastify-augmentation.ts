// fastify.d.ts — put this in src/types/fastify.d.ts

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate:   (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin:   (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireVendor:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    user: {
      userId:    string;
      email:     string;
      role:      'customer' | 'vendor' | 'admin';
      vendorId?: string;
      iat?:      number;
      exp?:      number;
      [key: string]: any;
    };
  }
}

export {};