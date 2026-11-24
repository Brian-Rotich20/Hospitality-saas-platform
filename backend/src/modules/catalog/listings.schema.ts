import { z } from 'zod';

const locationSchema = z.object({
  county: z.string().trim().min(2, 'County is required').max(100),
  area: z.string().trim().min(2, 'Area is required').max(200),
  country: z.string().max(100).default('Kenya'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const pricingType = z.enum(['per_hour', 'per_day', 'per_person', 'package', 'contact']);
const amount = z.number().positive().max(100_000_000);

export const createListingSchema = z.object({
  categoryId: z.string().uuid('Invalid category'),
  title: z.string().trim().min(5, 'Title must be at least 5 characters').max(255),
  description: z.string().trim().min(20, 'Description must be at least 20 characters').max(5000),
  location: locationSchema,
  pricingType,
  price: amount.optional(),
  minPrice: amount.optional(),
  maxPrice: amount.optional(),
  currency: z.literal('KES').default('KES'),
  photos: z.array(z.string().url().max(500)).max(20).default([]),
  coverPhoto: z.string().url().max(500).optional(),
});

export const updateListingSchema = createListingSchema.partial().extend({
  photos: z.array(z.string().url().max(500)).max(20).optional(),
  currency: z.literal('KES').optional(),
});

export const listingStatusSchema = z.object({ status: z.enum(['active', 'paused']) });

export const searchListingsSchema = z.object({
  categoryId: z.string().uuid().optional(),
  categorySlug: z.string().max(100).optional(),
  county: z.string().max(100).optional(),
  area: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  vendorId: z.string().uuid().optional(),
  sortBy: z.enum(['price', 'newest', 'popular']).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// ── Response contract (documented in OpenAPI; also enforced on serialisation) ──
// Loose objects: only the fields whose types are part of the contract are declared; all
// other listing fields pass through unchanged.
const money = z.string().regex(/^\d+(\.\d{1,2})?$/).nullable()
  .describe('Display price as an exact decimal string, e.g. "50000.00"; null when not set. Informational only: nothing is charged.');
export const listingView = z.looseObject({
  id: z.string(),
  vendorId: z.string(),
  slug: z.string(),
  status: z.string(),
  pricingType: z.string(),
  price: money,
  minPrice: money,
  maxPrice: money,
  currency: z.string(),
  rating: z.number().nullable().describe('Average rating, one decimal (e.g. 4.5); null until the first review'),
  reviewCount: z.number().int(),
});
const envelope = <T extends z.ZodType>(data: T) => z.looseObject({ success: z.literal(true), data });
export const listingResponse = envelope(listingView);
export const listingListResponse = envelope(z.array(listingView));
export const listingSearchResponse = z.looseObject({ success: z.literal(true), data: z.array(listingView), count: z.number().int(), total: z.number().int() });

export type CreateListingInput = z.infer<typeof createListingSchema>;
export type UpdateListingInput = z.infer<typeof updateListingSchema>;
export type SearchListingsInput = z.infer<typeof searchListingsSchema>;
