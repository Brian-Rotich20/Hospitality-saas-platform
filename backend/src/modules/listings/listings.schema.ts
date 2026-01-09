import { z } from 'zod';

// Create listing schema
export const createListingSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(255),
  description: z.string().min(50, 'Description must be at least 50 characters').max(5000),
  category: z.enum(['event_venue', 'catering', 'accommodation', 'other']),
  
  location: z.string().min(3, 'Location is required'),
  address: z.string().min(10, 'Full address is required'),
  county: z.string().optional(),
  city: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  
  capacity: z.number().int().positive().optional(),
  basePrice: z.number().positive('Price must be greater than 0'),
  
  photos: z.array(z.string().url()).min(1, 'At least 1 photo is required').max(20),
  coverPhoto: z.string().url().optional(),
  
  amenities: z.array(z.string()).default([]),
  
  instantBooking: z.boolean().default(false),
  minBookingDuration: z.number().int().positive().default(1),
  maxBookingDuration: z.number().int().positive().default(30),
  leadTime: z.number().int().positive().default(1),
});

// Update listing schema
export const updateListingSchema = createListingSchema.partial();

// Publish listing schema
export const publishListingSchema = z.object({
  status: z.enum(['active', 'paused']),
});

// Search/filter schema
export const searchListingsSchema = z.object({
  category: z.enum(['event_venue', 'catering', 'accommodation', 'other']).optional(),
  location: z.string().optional(),
  minPrice: z.number().positive().optional(),
  maxPrice: z.number().positive().optional(),
  minCapacity: z.number().int().positive().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export type CreateListingInput = z.infer<typeof createListingSchema>;
export type UpdateListingInput = z.infer<typeof updateListingSchema>;
export type PublishListingInput = z.infer<typeof publishListingSchema>;
export type SearchListingsInput = z.infer<typeof searchListingsSchema>;