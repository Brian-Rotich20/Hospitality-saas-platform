import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';

const authController = new AuthController();

export async function authRoutes(fastify: FastifyInstance) {

  // ── Public ────────────────────────────────────────────────────────────────────
  fastify.post('/register', {
    schema: { tags: ['Auth'], description: 'Register a new customer account' },
  }, authController.register.bind(authController));

  fastify.post('/login', {
    schema: { tags: ['Auth'], description: 'Login and receive access + refresh tokens' },
  }, authController.login.bind(authController));

  fastify.post('/refresh', {
    schema: { tags: ['Auth'], description: 'Refresh access token using refresh token' },
  }, authController.refresh.bind(authController));

  // ── Authenticated ─────────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Auth'], description: 'Get current user profile' },
  }, authController.getMe.bind(authController));

  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Auth'], description: 'Logout current session' },
  }, authController.logout.bind(authController));

  fastify.post('/logout-all', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Auth'], description: 'Logout from all devices' },
  }, authController.logoutAll.bind(authController));
}

export default authRoutes;