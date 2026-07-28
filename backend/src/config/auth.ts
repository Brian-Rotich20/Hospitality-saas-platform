// src/lib/auth.ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../config/database.js';

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.API_URL ?? 'http://localhost:3000',

  database: drizzleAdapter(db, {
    provider: 'pg',
    usePlural: true,   // matches your existing table naming (users, vendors, etc. — plural)
  }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,   // we'll wire your OTP flow on top later, not yet
  },

  trustedOrigins: [
    'https://linkmart-olive.vercel.app',
    'http://localhost:3000',
  ],

  // Custom fields on the user record — this is step 3, added now so schema gen picks it up
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'customer',
        input: false,   // prevents client from setting their own role at signup — server-only
      },
      vendorId: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },
});

export type Auth = typeof auth;