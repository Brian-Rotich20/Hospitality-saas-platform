import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerSchema, loginSchema } from './auth.schema';

const authController = new AuthController();

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', {
    schema: {
      body: zodToJsonSchema(registerSchema, { name: 'Register' }), // ensures valid JSON Schema
      tags: ['Auth'],
      description: 'Register user',
    },
  }, authController.register.bind(authController));

    fastify.post('/login', {
      schema: {
        body: zodToJsonSchema(loginSchema, { name: 'Login' }),
        tags: ['Authentication'],
      },
    }, authController.login.bind(authController));

}