import { randomUUID }     from 'crypto';
import type { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { AuthService }    from './auth.service';
import { redis }          from '../../config/redis';
import { VendorService }  from '../vendors/vendors.service';

const authController = new AuthController();
const authService    = new AuthService();
const vendorService  = new VendorService();

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
    schema: { tags: ['Auth'] },
  }, authController.register.bind(authController));

  fastify.post('/login', {
    schema: { tags: ['Auth'] },
  }, authController.login.bind(authController));

  fastify.post('/refresh', {
    schema: { tags: ['Auth'] },
  }, authController.refresh.bind(authController));

  // ── Google: initiate — stores intent in Redis, redirects to Google ──────────
  fastify.get('/google', async (request, reply) => {
    const intent    = (request.query as any).intent ?? 'customer';
    const stateKey  = `oauth:state:${randomUUID()}`;

    // Store intent for 10 minutes — read after callback
    await redis.setex(stateKey, 600, intent);

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

  // ── Google: callback ────────────────────────────────────────────────────────
  fastify.get('/google/callback', async (request, reply) => {
    const base = process.env.FRONTEND_URL ?? 'https://linkmart-olive.vercel.app';

    try {
      const { code, state } = request.query as { code?: string; state?: string };
      if (!code) throw new Error('No authorization code received from Google');

      // Exchange code for access token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          code,
          client_id:     process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri:  `${process.env.API_URL}/api/auth/google/callback`,
          grant_type:    'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Google token exchange failed: ${err}`);
      }

      const { access_token } = await tokenRes.json() as { access_token: string };

      // Fetch Google profile
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!profileRes.ok) throw new Error('Failed to fetch Google profile');

      const profile = await profileRes.json() as {
        id: string; email: string; name: string; picture?: string;
      };
      if (!profile.id || !profile.email) throw new Error('Incomplete Google profile');

      // Read intent from Redis
      let intent = 'customer';
      if (state) {
        const stored = await redis.get(state) as string | null;
        if (stored) {
          intent = stored;
          await redis.del(state);
        }
      }

      // Create or find user
      const result = await authService.googleAuth({
        googleId:  profile.id,
        email:     profile.email,
        fullName:  profile.name,
        avatarUrl: profile.picture,
      });

      // If vendor intent — create vendor record if not exists
      if (intent === 'vendor') {
        try {
          await vendorService.applyAsVendor(result.user.id, {
            businessName: profile.name,
          });
        } catch {
          // Already exists — fine, continue to onboarding
        }
      }

      reply.setCookie('refreshToken', result.refreshToken, refreshCookieOptions());

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
    schema:     { tags: ['Auth'] },
  }, authController.getMe.bind(authController));

  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
  }, authController.logout.bind(authController));

  fastify.post('/logout-all', {
    preHandler: [fastify.authenticate],
  }, authController.logoutAll.bind(authController));
}

export default authRoutes;