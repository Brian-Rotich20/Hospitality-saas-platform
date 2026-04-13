import { z } from 'zod';

// ─── Location — county + area from Nominatim, no city field
const locationSchema = z.object({
  county:    z.string().min(2, 'County is required'),
  area:      z.string().min(2, 'Area is required'),
  country:   z.string().default('Kenya'),
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

// ─── Create listing base — stripped to essentials only
const createListingBase = z.object({
  categoryId:  z.string().uuid('Invalid category'),
  title:       z.string().min(5,  'Title must be at least 5 characters').max(255),
  description: z.string().min(20, 'Description must be at least 20 characters').max(5000),
  location:    locationSchema,

  pricingType: z.enum(['per_hour', 'per_day', 'per_person', 'package', 'contact']),
  price:       z.number().positive().optional(),
  minPrice:    z.number().positive().optional(),
  maxPrice:    z.number().positive().optional(),
  currency:    z.string().length(3).default('KES'),

  photos:     z.array(z.string().url()).max(20).default([]),
  coverPhoto: z.string().url().optional(),
});

// ─── Create WITH price validation
export const createListingSchema = createListingBase.refine(data => {
  if (data.pricingType === 'package')  return data.minPrice != null && data.maxPrice != null;
  if (data.pricingType !== 'contact')  return data.price != null;
  return true;
}, { message: 'Price is required for this pricing type', path: ['price'] });

// ─── Update = partial of BASE
export const updateListingSchema = createListingBase.partial().refine(data => {
  if (data.pricingType === 'package')  return data.minPrice != null && data.maxPrice != null;
  if (data.pricingType != null && data.pricingType !== 'contact') return data.price != null;
  return true;
}, { message: 'Price is required for this pricing type', path: ['price'] });

// ─── Status update
export const publishListingSchema = z.object({
  status: z.enum(['active', 'paused']),
});

// ─── Search / filters — county replaces city
export const searchListingsSchema = z.object({
  categoryId:   z.string().uuid().optional(),
  categorySlug: z.string().optional(),
  county:       z.string().optional(),
  area:         z.string().optional(),
  search:       z.string().optional(),
  minPrice:     z.coerce.number().positive().optional(),
  maxPrice:     z.coerce.number().positive().optional(),
  sortBy:       z.enum(['price', 'newest', 'popular']).default('newest'),
  limit:        z.coerce.number().int().positive().max(100).default(20),
  offset:       z.coerce.number().int().min(0).default(0),
});

export type CreateListingInput  = z.infer<typeof createListingSchema>;
export type UpdateListingInput  = z.infer<typeof updateListingSchema>;
export type PublishListingInput = z.infer<typeof publishListingSchema>;
export type SearchListingsInput = z.infer<typeof searchListingsSchema>;