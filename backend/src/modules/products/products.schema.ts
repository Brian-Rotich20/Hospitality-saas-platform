import { z } from 'zod';

// ─── Variant ──────────────────────────────────────────────────────────────────
const variantSchema = z.object({
  name:       z.string().min(1).max(100),
  price:      z.number().positive().optional(),    // overrides base price if set
  attributes: z.record(z.string(), z.string()).optional(),      // { color: 'Red', size: 'L' }
});

// ─── Create product ───────────────────────────────────────────────────────────
const createProductBase = z.object({
  categoryId:      z.string().uuid('Invalid category').optional(),
  title:           z.string().min(3).max(255),
  description:     z.string().min(10).max(3000).optional(),
  price:           z.number().positive('Price must be greater than 0'),
  currency:        z.string().length(3).default('KES'),
  photos:          z.array(z.string().url()).max(10).default([]),
  coverPhoto:      z.string().url().optional(),
  whatsappMessage: z.string().max(300).optional(),
  isDigital:       z.boolean().default(false),
  variants:        z.array(variantSchema).max(20).optional(),
  trackStock:      z.boolean().default(false),
  quantity:        z.number().int().min(0).optional(),
  lowStockAt:      z.number().int().min(0).default(5),
});

// Create = base (no refine needed for products)
export const createProductSchema = createProductBase;

// Update = partial of base
export const updateProductSchema = createProductBase.partial()
// ─── Status update ────────────────────────────────────────────────────────────
export const updateProductStatusSchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'out_of_stock', 'deleted']),
});

// ─── Search/filter ────────────────────────────────────────────────────────────
export const searchProductsSchema = z.object({
  categoryId:   z.string().uuid().optional(),
  categorySlug: z.string().optional(),
  vendorId:     z.string().uuid().optional(),
  search:       z.string().optional(),
  minPrice:     z.coerce.number().positive().optional(),
  maxPrice:     z.coerce.number().positive().optional(),
  isDigital:    z.coerce.boolean().optional(),
  sortBy:       z.enum(['price', 'newest', 'popular']).default('newest'),
  limit:        z.coerce.number().int().positive().max(100).default(20),
  offset:       z.coerce.number().int().min(0).default(0),
});

// ─── Inventory update ─────────────────────────────────────────────────────────
export const updateInventorySchema = z.object({
  quantity:   z.number().int().min(0),
  lowStockAt: z.number().int().min(0).optional(),
  trackStock: z.boolean().optional(),
});

export type CreateProductInput      = z.infer<typeof createProductSchema>;
export type UpdateProductInput      = z.infer<typeof updateProductSchema>;
export type UpdateProductStatusInput = z.infer<typeof updateProductStatusSchema>;
export type SearchProductsInput     = z.infer<typeof searchProductsSchema>;
export type UpdateInventoryInput    = z.infer<typeof updateInventorySchema>;