import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards } from '../../app/policies.js';
import { idParams, ok } from '../../app/http.js';
import { categoriesService } from './categories.service.js';

const createBody = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens').optional(),
  icon: z.string().max(50).optional(),
  imageUrl: z.string().url().max(500).optional(),
  parentId: z.string().uuid().optional(),
});
const updateBody = createBody.partial().extend({ parentId: z.string().uuid().nullable().optional() });

/** Mounted at /api/categories. Reads are public; writes are admin-only. */
export const categoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', { schema: { tags: ['Categories'] } }, async () => ok(await categoriesService.topLevel()));
  app.get('/tree', { schema: { tags: ['Categories'] } }, async () => ok(await categoriesService.tree()));
  app.get('/slug/:slug', { schema: { tags: ['Categories'], params: z.object({ slug: z.string().min(1).max(100) }) } },
    async (request) => ok(await categoriesService.bySlug(request.params.slug)));
  app.get('/:id', { schema: { tags: ['Categories'], params: idParams } }, async (request) => ok(await categoriesService.byId(request.params.id)));
  app.get('/:id/subcategories', { schema: { tags: ['Categories'], params: idParams } }, async (request) => ok(await categoriesService.children(request.params.id)));

  app.post('/', { preValidation: guards.admin, schema: { tags: ['Categories'], body: createBody } }, async (request, reply) => {
    reply.code(201);
    return ok(await categoriesService.create(request.body), { message: 'Category created' });
  });
  app.put('/:id', { preValidation: guards.admin, schema: { tags: ['Categories'], params: idParams, body: updateBody } },
    async (request) => ok(await categoriesService.update(request.params.id, request.body), { message: 'Category updated' }));
  app.delete('/:id', { preValidation: guards.admin, schema: { tags: ['Categories'], params: idParams } }, async (request) => {
    await categoriesService.remove(request.params.id);
    return ok(null, { message: 'Category deleted' });
  });
};
