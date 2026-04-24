import '@fastify/oauth2';
import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { AuthService }    from './auth.service';
import { redis }          from '../../config/redis';
import { randomUUID }     from 'crypto';

const authController = new AuthController();
const authService    = new AuthService();

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'none' as const,
    maxAge:   60 * 60 * 24 * 7,
    path:     '/',
  };
}

export async function authRoutes(fastify: FastifyInstance) {

  // ── Public ──────────────────────────────────────────────────────────────────
  fastify.post('/register', {
    schema: { tags: ['Auth'], description: 'Register a new customer account' },
  }, authController.register.bind(authController));

  fastify.post('/login', {
    schema: { tags: ['Auth'], description: 'Login' },
  }, authController.login.bind(authController));

  fastify.post('/refresh', {
    schema: { tags: ['Auth'], description: 'Refresh access token' },
  }, authController.refresh.bind(authController));

  // ── Google: manual redirect — reads intent from query param ────────────────
  // startRedirectPath is NOT used — we need to intercept to store intent
  fastify.get('/google', async (request, reply) => {
    const intent = (request.query as any).intent ?? 'customer';

    // Generate a state token — store intent in Redis for 10 minutes
    const stateKey = `oauth:state:${randomUUID()}`;
    await redis.setex(stateKey, 600, intent);

    // Build the Google authorization URL manually with state = stateKey
    const params = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      redirect_uri:  `${process.env.API_URL}/api/auth/google/callback`,
      response_type: 'code',
      scope:         'openid email profile',
      state:         stateKey,
      access_type:   'offline',
      prompt:        'select_account',
    });

    return reply.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    );
  });

  // ── Google callback ─────────────────────────────────────────────────────────
  fastify.get('/google/callback', async (request, reply) => {
    const base = process.env.FRONTEND_URL ?? 'https://linkmart-olive.vercel.app';

    try {
      const { code, state } = request.query as { code?: string; state?: string };

      if (!code) throw new Error('No authorization code received');

      // ── Exchange code for token manually ──────────────────────────────────
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri:  `${process.env.API_URL}/api/auth/google/callback`,
          grant_type:    'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token exchange failed: ${err}`);
      }

      const tokenData = await tokenRes.json() as { access_token: string };

      // ── Fetch Google profile ───────────────────────────────────────────────
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!profileRes.ok) throw new Error('Failed to fetch Google profile');

      const profile = await profileRes.json() as {
        id: string; email: string; name: string; picture?: string;
      };

      if (!profile.id || !profile.email) {
        throw new Error('Incomplete profile from Google');
      }

      // ── Read intent from Redis using state key ────────────────────────────
      let intent = 'customer';
      if (state) {
        const stored = await redis.get(state) as string | null;
        if (stored) {
          intent = stored;
          await redis.del(state); // single use
        }
      }

      // ── Create/find user ──────────────────────────────────────────────────
      const result = await authService.googleAuth({
        googleId:  profile.id,
        email:     profile.email,
        fullName:  profile.name,
        avatarUrl: profile.picture,
      });

      // ── If vendor intent + new user — create vendor record ────────────────
      if (intent === 'vendor') {
        const { VendorService } = await import('../vendors/vendors.service');
        const vendorService = new VendorService();
        try {
          await vendorService.applyAsVendor(result.user.id, {
            businessName: profile.name,
          });
        } catch {
          // Vendor record may already exist — not a fatal error
        }
      }

      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

      // ── Redirect based on intent ───────────────────────────────────────────
      const dest = intent === 'vendor'
        ? `${base}/vendor/onboarding?token=${result.accessToken}`
        : `${base}/auth/callback?token=${result.accessToken}`;

      return reply.redirect(dest);

    } catch (err: any) {
      fastify.log.error({ err: err.message }, 'Google OAuth callback failed');
      return reply.redirect(`${base}/auth/login?error=google_failed`);
    }
  });

  // ── Authenticated ───────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema:     { tags: ['Auth'], description: 'Get current user' },
  }, authController.getMe.bind(authController));

  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
  }, authController.logout.bind(authController));

  fastify.post('/logout-all', {
    preHandler: [fastify.authenticate],
  }, authController.logoutAll.bind(authController));
}

export default authRoutes;