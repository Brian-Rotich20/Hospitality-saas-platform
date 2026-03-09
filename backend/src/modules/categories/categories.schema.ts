import { z } from 'zod';

export const createCategorySchema = z.object({
  name:     z.string().min(2, 'Name must be at least 2 characters').max(100),
  slug:     z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens only').optional(),
  icon:     z.string().max(50).optional(),
  parentId: z.string().uuid('Invalid parent category').optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;