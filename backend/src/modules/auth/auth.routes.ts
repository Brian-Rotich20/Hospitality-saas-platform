import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import '@fastify/oauth2';

const authController = new AuthController();
const authService    = new AuthService();

export async function authRoutes(fastify: FastifyInstance) {

  // ── Public ─────────────────────────────────────────────────────────────────
  fastify.post('/register', {
    schema: { tags: ['Auth'], description: 'Register a new customer account' },
  }, authController.register.bind(authController));

  fastify.post('/login', {
    schema: { tags: ['Auth'], description: 'Login' },
  }, authController.login.bind(authController));

  fastify.post('/refresh', {
    schema: { tags: ['Auth'], description: 'Refresh access token' },
  }, authController.refresh.bind(authController));

  // ── Google OAuth ────────────────────────────────────────────────────────────
  // GET /auth/google?state=customer  OR  ?state=vendor
  fastify.get('/google', async (request, reply) => {
    const state  = (request.query as any).state ?? 'customer';
    const authUrl = await fastify.googleOAuth2.generateAuthorizationUri(
      request,
      reply,
      { state },
    );
    return reply.redirect(authUrl);
  });

  fastify.get('/google/callback', async (request, reply) => {
    try {
      const token = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token.token.access_token}` },
      });
      const profile = await profileRes.json() as {
        id: string; email: string; name: string; picture?: string;
      };

      const result = await authService.googleAuth({
        googleId:  profile.id,
        email:     profile.email,
        fullName:  profile.name,
        avatarUrl: profile.picture,
      });

      reply.setCookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure:   true,
        sameSite: 'none',
        maxAge:   60 * 60 * 24 * 7,
        path:     '/',
      });

      // state was forwarded by Google as-is
      const state  = (request.query as any).state ?? 'customer';
      const base   = process.env.FRONTEND_URL!;
      const dest   = state === 'vendor'
        ? `${base}/vendor/onboarding?token=${result.accessToken}`
        : `${base}/auth/callback?token=${result.accessToken}`;

      return reply.redirect(dest);
    } catch (err: any) {
      return reply.redirect(`${process.env.FRONTEND_URL}/auth/login?error=google_failed`);
    }
  });

  // ── Authenticated ───────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['Auth'], description: 'Get current user' },
  }, authController.getMe.bind(authController));

  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
  }, authController.logout.bind(authController));

  fastify.post('/logout-all', {
    preHandler: [fastify.authenticate],
  }, authController.logoutAll.bind(authController));
}

export default authRoutes;