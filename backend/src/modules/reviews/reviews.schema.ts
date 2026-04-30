// src/modules/reviews/reviews.schema.ts
import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z.string().uuid(),
  rating:    z.number().int().min(1).max(5),
  title:     z.string().max(120).optional(),
  body:      z.string().min(10, 'Review must be at least 10 characters').max(2000),
});

export const vendorReplySchema = z.object({
  reply: z.string().min(5).max(1000),
});

export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type VendorReplyInput  = z.infer<typeof vendorReplySchema>;