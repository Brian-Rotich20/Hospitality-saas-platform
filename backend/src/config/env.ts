import  { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string(),
  JWT_EXPIRES_IN: z.string().default('7d'),


// export const env = envSchema.parse(process.env);
// // Storage
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
  
  // Upload limits
  MAX_FILE_SIZE: z.string().default('5242880'),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),
  ALLOWED_DOCUMENT_TYPES: z.string().default('application/pdf,image/jpeg,image/png'),

    // Flutterwave
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_ENCRYPTION_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
  
  // Payment URLs
  PAYMENT_CALLBACK_URL: z.string().optional(),
  PAYMENT_REDIRECT_URL: z.string().optional(),

  // SendGrid
   SENDGRID_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().email().optional(),
  FROM_NAME: z.string().optional(),
  
  // SMS
  AFRICASTALKING_API_KEY: z.string().optional(),
  AFRICASTALKING_USERNAME: z.string().optional(),
  
  // URLs
  APP_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);

export const config = {
  maxFileSize: parseInt(env.MAX_FILE_SIZE),
  allowedImageTypes: env.ALLOWED_IMAGE_TYPES.split(','),
  allowedDocumentTypes: env.ALLOWED_DOCUMENT_TYPES.split(','),
};