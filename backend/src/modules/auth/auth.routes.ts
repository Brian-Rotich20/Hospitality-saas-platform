import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';

const authController = new AuthController();

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', {
    schema: {
      tags: ['Auth'],
      description: 'Register user',
    },
  }, authController.register.bind(authController));

    fastify.post('/login', {
      schema: {
        tags: ['Authentication'],
      },
    }, authController.login.bind(authController));

}

export default authRoutes;