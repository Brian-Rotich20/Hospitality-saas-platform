import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { registerSchema, loginSchema } from './auth.schema';

const authController = new AuthController();

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', {
    schema: {
      body: registerSchema,
      tags: ['Authentication'],
    },
  }, authController.register);

  fastify.post('/login', {
    schema: {
      body: loginSchema,
      tags: ['Authentication'],
    },
  }, authController.login);
}