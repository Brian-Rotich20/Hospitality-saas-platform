import { z } from 'zod';

export const initiateMpesaPaymentSchema = z.object({
  bookingId: z.string().uuid(),
  phoneNumber: z.string().regex(/^(\+254|254|0)[17]\d{8}$/, 'Invalid Kenyan phone number'),
});

export const verifyPaymentSchema = z.object({
  transactionId: z.string(),
});

export type InitiateMpesaPaymentInput = z.infer<typeof initiateMpesaPaymentSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;