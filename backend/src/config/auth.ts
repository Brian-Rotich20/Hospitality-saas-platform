import { betterAuth } from 'better-auth';
import { randomUUID } from 'crypto';
import { admin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './database.js';
import { users } from '../db/schema/users.js';
import { sessions, accounts, verifications } from '../db/schema/auth.js';
import { env } from './env.js';
import { sendCustomerOTP } from '../utils/otp.js';




export const auth = betterAuth({
  secret:  env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL ?? env.API_URL ?? 'http://localhost:3000',
  basePath: '/api/auth',


  advanced: {
    database: {
      generateId: () => randomUUID(),   // ← force UUID format to match your existing schema
    },
  },

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

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },

  socialProviders: {
    google: {
      clientId:     env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
    },
  },

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

  // ── Fire LinkMart's own OTP flow right after Better Auth creates a user ────
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Google-created users arrive already verified — skip OTP entirely.
          if (user.emailVerified) return;

          await sendCustomerOTP(
            user.id,
            user.email,
            (user as any).fullName ?? user.name ?? 'there',
          ).catch(err => console.error('[Register OTP hook failed]', err));
        },
      },
    },
  },
});

export type Auth = typeof auth;