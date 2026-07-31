import { type FastifyReply, type FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';

const authService = new AuthService();

export class AuthController {
  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const { otp } = request.body as { otp: string };
      if (!otp) return reply.code(400).send({ success: false, error: 'OTP is required' });

      const result = await authService.verifyCustomerOTP(userId, otp);

      return reply.send({
        success: true,
        message: 'Email verified! Welcome to LinkMart.',
        data: { user: result.user },
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  async resendOTP(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      await authService.resendCustomerOTP(userId);
      return reply.send({ success: true, message: 'Verification code sent to your email.' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}