import { FastifyInstance } from 'fastify';
import { ProductController } from './products.controller.js';

const productController = new ProductController();

export async function productRoutes(fastify: FastifyInstance) {

  // ── Public routes ─────────────────────────────────────────────────────────────

  fastify.get('/', {
    schema: { tags: ['Products'], description: 'Search/filter products' },
  }, productController.searchProducts.bind(productController));

  fastify.get('/featured', {
    schema: { tags: ['Products'], description: 'Get featured products for homepage' },
  }, productController.getFeaturedProducts.bind(productController));

  fastify.get('/vendor/:vendorId', {
    schema: { tags: ['Products'], description: 'Get all active products by vendor' },
  }, productController.getVendorProducts.bind(productController));

  // ⚠️ slug route must come before /:id to avoid conflict
  fastify.get('/slug/:slug', {
    schema: { tags: ['Products'], description: 'Get product by slug' },
  }, productController.getBySlug.bind(productController));

  fastify.get('/:id', {
    schema: { tags: ['Products'], description: 'Get product by ID' },
  }, productController.getById.bind(productController));

  // ── Vendor-authenticated routes ───────────────────────────────────────────────

  fastify.get('/me', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Get my products (vendor dashboard)' },
  }, productController.getMyProducts.bind(productController));

  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Create a new product' },
  }, productController.createProduct.bind(productController));

  fastify.put('/:id', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Update a product' },
  }, productController.updateProduct.bind(productController));

  fastify.patch('/:id/status', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Publish, pause, or mark out of stock' },
  }, productController.updateStatus.bind(productController));

  fastify.patch('/:id/inventory', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Update product inventory/stock' },
  }, productController.updateInventory.bind(productController));

  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, fastify.requireVendor],
    schema: { tags: ['Products'], description: 'Soft delete a product' },
  }, productController.deleteProduct.bind(productController));
}