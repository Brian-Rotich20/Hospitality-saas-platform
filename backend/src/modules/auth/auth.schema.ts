import { z } from 'zod';
// import { zodToJsonSchema } from 'zod-to-json-schema';

export const registerSchema = z.object({
  email: z.string().email(),
  phone: z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['customer', 'vendor']).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const verifyOTPSchema = z.object({
  phone: z.string(),
  otp: z.string().length(6),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;