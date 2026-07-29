import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './database.js';
import { users } from '../db/schema/users.js';
import { sessions, accounts, verifications } from '../db/schema/auth.js';
import { env } from './env.js';

export const auth = betterAuth({
  secret:  env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL ?? env.API_URL ?? 'http://localhost:3000',
  basePath: '/api/auth',

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user:         users,
      session:      sessions,
      account:      accounts,
      verification: verifications,
    },
  }),

  user: {
    fields: {
      name:          'fullName',
      image:         'avatarUrl',
      emailVerified: 'verified',
    },
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'customer',
        input: false,
      },
      vendorId: {
        type: 'string',
        required: false,
        input: false,
      },
      phone: {
        type: 'string',
        required: false,
      },
    },
  },

  // ── Default: email + password ────────────────────────────────────────────
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,   // your existing OTP flow stays LinkMart-owned
  },

  // ── Google as an additional option — more providers later, same pattern ──
  socialProviders: {
    google: {
      clientId:     env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
    },
  },

  // ── Admin tooling — session listing, ban/unban, impersonation ─────────────
  plugins: [
    admin({
      defaultRole: 'customer',
      adminRole:   'admin',
    }),
  ],

  trustedOrigins: [
    'https://linkmart-olive.vercel.app',
    'http://localhost:3000',
  ],

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});

export type Auth = typeof auth;