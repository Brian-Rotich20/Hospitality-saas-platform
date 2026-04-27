import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  // ── Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // ── Database & Cache
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),

  // ── Auth
  JWT_SECRET: z.string(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECRET: z.string(),

  // ── Storage
  STORAGE_PROVIDER: z.enum(['s3', 'cloudinary']).default('cloudinary'),

  // AWS S3
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // ── Upload limits
  MAX_FILE_SIZE: z.string().default('5242880'),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),
  ALLOWED_DOCUMENT_TYPES: z.string().default('application/pdf,image/jpeg,image/png'),

  // ── Payments (Flutterwave)
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_ENCRYPTION_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),

  // ── Paystack (you had this in .env but not schema ❗)
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_SECRET_KEY: z.string().optional(),

  // ── Payment URLs
  PAYMENT_CALLBACK_URL: z.string().optional(),
  PAYMENT_REDIRECT_URL: z.string().optional(),

  // ── Email
  RESEND_API_KEY: z.string().optional(), // you used Resend, not SendGrid
  FROM_EMAIL: z.string().email().optional(),
  FROM_NAME: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(), // in case you switch back to SendGrid

  // ── SMS
  AFRICASTALKING_API_KEY: z.string().optional(),
  AFRICASTALKING_USERNAME: z.string().optional(),

  // ── URLs
  APP_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),

  // ── Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  API_URL: z.string().optional(),

  // ── Clerk
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);

// ── Derived config (safe usage)
export const config = {
  maxFileSize: parseInt(env.MAX_FILE_SIZE, 10),
  allowedImageTypes: env.ALLOWED_IMAGE_TYPES.split(','),
  allowedDocumentTypes: env.ALLOWED_DOCUMENT_TYPES.split(','),
};