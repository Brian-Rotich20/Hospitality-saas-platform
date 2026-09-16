import { FastifyInstance } from 'fastify';
import { CustomerController } from './customers.controller.js';
import { z } from 'zod';

const customerController = new CustomerController();

export async function customerRoutes(fastify: FastifyInstance) {
  // ── GET /customers ─────────────────────────────────────────────────────────
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Customers'],
      querystring: z.object({
        page: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    },  customerController.getAllCustomers.bind(customerController));
  }


