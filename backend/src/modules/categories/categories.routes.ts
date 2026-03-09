import { FastifyInstance } from 'fastify';
import { CategoryController } from './categories.controller';

const categoryController = new CategoryController();

export async function categoryRoutes(fastify: FastifyInstance) {

  // ── Public routes ─────────────────────────────────────────────────────────────

  // GET /categories — top-level only (store header, nav strip)
  fastify.get('/', {
    schema: { tags: ['Categories'], description: 'Get all top-level categories' },
  }, categoryController.getTopLevel.bind(categoryController));

  // GET /categories/tree — full nested tree (listing forms, dropdowns)
  fastify.get('/tree', {
    schema: { tags: ['Categories'], description: 'Get full category tree with subcategories nested' },
  }, categoryController.getTree.bind(categoryController));

  // GET /categories/slug/:slug — by slug (URL-friendly)
  fastify.get('/slug/:slug', {
    schema: { tags: ['Categories'], description: 'Get category by slug' },
  }, categoryController.getBySlug.bind(categoryController));

  // GET /categories/:id — by ID
  fastify.get('/:id', {
    schema: { tags: ['Categories'], description: 'Get category by ID with subcategories' },
  }, categoryController.getById.bind(categoryController));

  // GET /categories/:id/subcategories — children only
  fastify.get('/:id/subcategories', {
    schema: { tags: ['Categories'], description: 'Get subcategories of a parent category' },
  }, categoryController.getSubcategories.bind(categoryController));

  // ── Admin routes ──────────────────────────────────────────────────────────────

  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Categories'], description: 'Admin: Create a new category' },
  }, categoryController.create.bind(categoryController));

  fastify.put('/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Categories'], description: 'Admin: Update a category' },
  }, categoryController.update.bind(categoryController));

  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: { tags: ['Categories'], description: 'Admin: Delete a category (no children allowed)' },
  }, categoryController.delete.bind(categoryController));
}