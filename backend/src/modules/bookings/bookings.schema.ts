import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createBookingSchema = z.object({
  listingId:       z.string().uuid(),
  startDate:       z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  endDate:         z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  guests:          z.number().int().positive(),
  specialRequests: z.string().max(1000).optional(),
}).refine(
  data => new Date(data.endDate) >= new Date(data.startDate),
  { message: 'End date must be on or after start date' }
);

export const declineBookingSchema = z.object({
  reason: z.string().min(10, 'Please provide at least 10 characters').max(500),
});

export const cancelBookingSchema = z.object({
  reason: z.string().min(10, 'Please provide at least 10 characters').max(500),
});

export const getBookingsSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'declined', 'disputed']).optional(),
  limit:  z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateBookingInput  = z.infer<typeof createBookingSchema>;
export type DeclineBookingInput = z.infer<typeof declineBookingSchema>;
export type CancelBookingInput  = z.infer<typeof cancelBookingSchema>;
export type GetBookingsInput    = z.infer<typeof getBookingsSchema>;