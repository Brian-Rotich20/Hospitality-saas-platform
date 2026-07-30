import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthController } from './auth.controller.js';

const authController = new AuthController();

export async function otpRoutes(fastify: FastifyInstance) {
  fastify.post('/verify-email', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['OTP'], body: z.object({ otp: z.string().min(6).max(6) }) },
  }, authController.verifyEmail.bind(authController));

  fastify.post('/resend-otp', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['OTP'] },
  }, authController.resendOTP.bind(authController));
}