// Better Auth: identity, password storage, sessions, Google sign-in, admin ban tools.
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { randomUUID } from 'node:crypto';
import { db } from '../../platform/database/client.js';
import { users } from '../../platform/database/schema/users.js';
import { sessions, accounts, verifications } from '../../platform/database/schema/auth.js';
import { env, isProduction } from '../../platform/config/env.js';
import { logger } from '../../platform/logger.js';
import { otpService } from './otp.service.js';
import { enqueueOutbox } from '../notifications/outbox.js';

/** Password-reset link lifetime. */
export const PASSWORD_RESET_TTL_MINUTES = 60;
/** At most one reset email per account within this window. */
export const PASSWORD_RESET_EMAIL_WINDOW_MINUTES = 5;

const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
  ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
  : {};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  trustedOrigins: env.CORS_ORIGINS,

  advanced: {
    database: { generateId: () => randomUUID() },
    useSecureCookies: isProduction,
    // Better Auth skips origin/callbackURL checks under NODE_ENV=test by default; keep them
    // on everywhere so tests exercise the production behaviour (trusted origins = CORS_ORIGINS
    // plus the BETTER_AUTH_URL origin).
    disableOriginCheck: false,
  },

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user: users, session: sessions, account: accounts, verification: verifications },
  }),

  user: {
    fields: { name: 'fullName', image: 'avatarUrl', emailVerified: 'verified' },
    additionalFields: {
      // Never settable by the client: role changes only through LinkMart services.
      role:     { type: 'string', defaultValue: 'customer', input: false },
      vendorId: { type: 'string', required: false, input: false },
      phone:    { type: 'string', required: false },
    },
  },

  emailAndPassword: {
    enabled: true, requireEmailVerification: false, minPasswordLength: 8,
    // Password reset (Better Auth flow): POST /request-password-reset -> email ->
    // POST /reset-password { token, newPassword }. Tokens are single-use and expire.
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_MINUTES * 60,
    // A reset signs every existing session out (a stolen session can't survive it).
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      // Delivered by the worker through the outbox. At most one email per account per
      // window, so the endpoint can't be used to flood someone's inbox. Errors are logged,
      // never surfaced: the response must not reveal whether the account exists.
      try {
        const windowStart = Math.floor(Date.now() / (PASSWORD_RESET_EMAIL_WINDOW_MINUTES * 60_000));
        await enqueueOutbox(db, 'auth.password_reset', { userId: user.id, token, validMinutes: PASSWORD_RESET_TTL_MINUTES },
          { dedupeKey: `password-reset:${user.id}:${windowStart}` });
      } catch (err) {
        logger.error({ userId: user.id, err: (err as Error).message }, 'password reset email could not be queued');
      }
    },
  },
  socialProviders: google,
  plugins: [admin({ defaultRole: 'customer', adminRoles: ['admin'] })],

  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // OAuth users arrive verified; everyone else gets LinkMart's email OTP.
          if (user.emailVerified) return;
          const name = (user as typeof user & { fullName?: string }).fullName ?? user.name;
          await otpService.issue(user.id, user.email, name || 'there').catch((err: unknown) =>
            logger.error({ userId: user.id, err: (err as Error).message }, 'sign-up OTP send failed'));
        },
      },
    },
  },
});

/**
 * Admin-plugin endpoints that would bypass LinkMart's invariants (a role without a vendor
 * profile, hard-deleting users with bookings, account takeover via impersonation or
 * password reset). They are refused at the bridge; LinkMart services cover the needs.
 */
export const BLOCKED_AUTH_PATHS = new Set([
  '/api/auth/admin/set-role',
  '/api/auth/admin/create-user',
  '/api/auth/admin/remove-user',
  '/api/auth/admin/impersonate-user',
  '/api/auth/admin/stop-impersonating',
  '/api/auth/admin/set-user-password',
  '/api/auth/admin/update-user',
]);
