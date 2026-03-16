import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { registerSchema, loginSchema } from './auth.schema';

const authService = new AuthService();

// ── Cookie config helper
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   true,          // ✅ always true — Render is always HTTPS
    sameSite: 'none' as const, // ✅ allows cross-origin (Vercel → Render)
    maxAge:   60 * 60 * 24 * 7, // 7 days
    path:     '/',           // ✅ send on ALL paths, not just /api/auth
  };
}

export class AuthController {

  // ── POST /auth/register
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body   = registerSchema.parse(request.body);
      const result = await authService.register(body);

      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.code(201).send({
        success: true,
        message: 'Account created successfully',
        data: {
          user:        result.user,
          accessToken: result.accessToken,
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

  // ── POST /auth/login 
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
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── POST /auth/refresh
  async refresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      // Accept from httpOnly cookie (web) or body (mobile)
      const token = (request.cookies as any)?.refreshToken
        ?? (request.body as any)?.refreshToken;

      if (!token) {
        return reply.code(401).send({ success: false, error: 'Refresh token required' });
      }

      const result = await authService.refresh(token);

      // Rotate — issue new cookie
      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      return reply.code(200).send({
        success: true,
        data: { accessToken: result.accessToken },
      });
    } catch (error: any) {
      // Clear invalid cookie
      reply.clearCookie('refreshToken', { path: '/' });
      return reply.code(401).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/logout 
  async logout(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const token  = (request.cookies as any)?.refreshToken
        ?? (request.body as any)?.refreshToken;

      if (token) await authService.logout(userId, token);

      reply.clearCookie('refreshToken', { path: '/' });

      return reply.code(200).send({ success: true, message: 'Logged out successfully' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── POST /auth/logout-all
  async logoutAll(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      await authService.logoutAll(userId);
      reply.clearCookie('refreshToken', { path: '/' });
      return reply.code(200).send({ success: true, message: 'Logged out from all devices' });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /auth/me 
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