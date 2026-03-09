import { z } from 'zod';

// ─── Location ─────────────────────────────────────────────────────────────────
const locationSchema = z.object({
  address:   z.string().optional(),
  city:      z.string().min(2, 'City is required'),
  county:    z.string().optional(),
  country:   z.string().default('Kenya'),
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

// ─── Create listing ───────────────────────────────────────────────────────────
 const createListingBase  = z.object({
  // ✅ categoryId — dynamic FK, not hardcoded enum
  categoryId: z.string().uuid('Invalid category'),

  title:       z.string().min(5, 'Title must be at least 5 characters').max(255),
  description: z.string().min(20, 'Description must be at least 20 characters').max(5000),

  // ✅ Structured location object
  location: locationSchema,

  capacity: z.number().int().positive().optional(),

  // ✅ Flexible pricing
  pricingType: z.enum(['fixed', 'per_day', 'per_hour', 'per_person', 'range', 'package']),
  price:       z.number().positive().optional(),     // used for all types except range
  minPrice:    z.number().positive().optional(),     // range only
  maxPrice:    z.number().positive().optional(),     // range only
  currency:    z.string().length(3).default('KES'),

  photos:     z.array(z.string().url()).max(20).default([]),
  coverPhoto: z.string().url().optional(),

  // ✅ Amenities optional
  amenities: z.array(z.string()).optional().default([]),

  instantBooking:     z.boolean().default(false),
  minBookingDuration: z.number().int().positive().default(1),
  maxBookingDuration: z.number().int().positive().default(30),
  leadTime:           z.number().int().min(0).default(1),
})

// Create WITH refine
export const createListingSchema = createListingBase.refine(data => {
  if (data.pricingType === 'range') {
    return data.minPrice != null && data.maxPrice != null;
  }
  return true;
}, { message: 'minPrice and maxPrice are required for range pricing', path: ['minPrice'] });

// Update = partial of BASE (not the refined schema)
export const updateListingSchema = createListingBase.partial().refine(data => {
  if (data.pricingType === 'range') {
    return data.minPrice != null && data.maxPrice != null;
  }
  return true;
}, { message: 'minPrice and maxPrice are required for range pricing', path: ['minPrice'] });

// ─── Status update ────────────────────────────────────────────────────────────
export const publishListingSchema = z.object({
  status: z.enum(['active', 'paused']),
});

// ─── Search / filters ─────────────────────────────────────────────────────────
export const searchListingsSchema = z.object({
  categoryId:   z.string().uuid().optional(),
  categorySlug: z.string().optional(),
  city:         z.string().optional(),
  search:       z.string().optional(),
  minPrice:     z.coerce.number().positive().optional(),
  maxPrice:     z.coerce.number().positive().optional(),
  minCapacity:  z.coerce.number().int().positive().optional(),
  sortBy:       z.enum(['price',  'newest', 'popular']).default('newest'),
  limit:        z.coerce.number().int().positive().max(100).default(20),
  offset:       z.coerce.number().int().min(0).default(0),
});

export type CreateListingInput  = z.infer<typeof createListingSchema>;
export type UpdateListingInput  = z.infer<typeof updateListingSchema>;
export type PublishListingInput = z.infer<typeof publishListingSchema>;
export type SearchListingsInput = z.infer<typeof searchListingsSchema>;