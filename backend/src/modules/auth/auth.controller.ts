// src/modules/auth/auth.controller.ts
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { registerSchema, loginSchema } from './auth.schema';

const authService = new AuthService();

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'none' as const,
    maxAge:   60 * 60 * 24 * 7,
    path:     '/',
  };
}

function setCookieHeader(reply: FastifyReply, name: string, value: string, maxAge: number) {
  // Non-httpOnly so Next.js middleware can read it client-side
  reply.setCookie(name, value, {
    httpOnly: false,
    secure:   true,
    sameSite: 'none',
    maxAge,
    path:     '/',
  });
}

export class AuthController {

  // ── POST /auth/register ────────────────────────────────────────────────────
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body   = registerSchema.parse(request.body);
      const result = await authService.register(body);

      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      // Always return 201 — frontend reads requiresVerification to redirect
      return reply.code(201).send({
        success: true,
        message: result.requiresVerification
          ? 'Account created. Please check your email for a verification code.'
          : 'Account created successfully.',
        data: {
          user:                  result.user,
          accessToken:           result.accessToken,
          requiresVerification:  result.requiresVerification,
        },
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── POST /auth/verify-email ────────────────────────────────────────────────
  // Works for BOTH customers (auth:otp:*) and vendors (via vendor controller)
  // This route handles customers only — vendors use /vendors/verify-email
  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const { otp } = request.body as { otp: string };

      if (!otp) {
        return reply.code(400).send({ success: false, error: 'OTP is required' });
      }

      const result = await authService.verifyCustomerOTP(userId, otp);

      // Rotate refresh token
      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.send({
        success:     true,
        message:     'Email verified! Welcome to LinkMart.',
        data: {
          user:        result.user,
          accessToken: result.accessToken,
        },
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/resend-otp ──────────────────────────────────────────────────
  async resendOTP(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      await authService.resendCustomerOTP(userId);
      return reply.send({ success: true, message: 'Verification code sent to your email.' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/login ───────────────────────────────────────────────────────
  async login(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body   = loginSchema.parse(request.body);
      const result = await authService.login(body);

      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.code(200).send({
        success: true,
        data: {
          user:        result.user,
          accessToken: result.accessToken,
        },
      });
    } catch (error: any) {
      // ── Unverified user — send 403 with a fresh token so they can reach verify page
      if (error?.code === 'EMAIL_NOT_VERIFIED') {
        return reply.code(403).send({
          success:              false,
          error:                error.message,
          code:                 'EMAIL_NOT_VERIFIED',
          accessToken:          error.accessToken,   // short-lived, emailVerified=false
          requiresVerification: true,
        });
      }

      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  async refresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      const token = (request.cookies as any)?.refreshToken
        ?? (request.body as any)?.refreshToken;

      if (!token) {
        return reply.code(401).send({ success: false, error: 'Refresh token required' });
      }

      const result = await authService.refresh(token);
      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.code(200).send({
        success: true,
        data: { accessToken: result.accessToken },
      });
    } catch (error: any) {
      reply.clearCookie('refreshToken', { path: '/' });
      return reply.code(401).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  async logout(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const token  = (request.cookies as any)?.refreshToken
        ?? (request.body as any)?.refreshToken;

      if (token) await authService.logout(userId, token);

      reply.clearCookie('refreshToken', {
        path: '/', httpOnly: true, secure: true, sameSite: 'none',
      });
      return reply.code(200).send({ success: true, message: 'Logged out successfully' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/logout-all ──────────────────────────────────────────────────
  async logoutAll(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      await authService.logoutAll(userId);
      reply.clearCookie('refreshToken', {
        path: '/', httpOnly: true, secure: true, sameSite: 'none',
      });
      return reply.code(200).send({ success: true, message: 'Logged out from all devices' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /auth/me ───────────────────────────────────────────────────────────
  async getMe(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const user   = await authService.getMe(userId);
      return reply.code(200).send({ success: true, data: user });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }
}