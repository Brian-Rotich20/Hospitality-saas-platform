import { z } from 'zod';

export const createBookingSchema = z.object({
  listingId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  guests: z.number().int().positive(),
  specialRequests: z.string().max(1000).optional(),
}).refine(
  (data) => new Date(data.endDate) >= new Date(data.startDate),
  { message: 'End date must be after or equal to start date' }
);

export const acceptBookingSchema = z.object({
  message: z.string().max(500).optional(),
});

export const declineBookingSchema = z.object({
  reason: z.string().min(10, 'Decline reason must be at least 10 characters').max(500),
});

export const cancelBookingSchema = z.object({
  reason: z.string().min(10, 'Cancellation reason must be at least 10 characters').max(500),
});

export const getBookingsSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'declined']).optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type AcceptBookingInput = z.infer<typeof acceptBookingSchema>;
export type DeclineBookingInput = z.infer<typeof declineBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type GetBookingsInput = z.infer<typeof getBookingsSchema>;