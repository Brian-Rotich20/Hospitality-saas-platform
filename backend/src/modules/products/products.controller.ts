import { FastifyRequest, FastifyReply } from 'fastify';
import { ProductService } from './products.service.js';
import {
  createProductSchema,
  updateProductSchema,
  updateProductStatusSchema,
  searchProductsSchema,
  updateInventorySchema,
} from './products.schema.js';

const productService = new ProductService();

export class ProductController {

  // ── POST /products ────────────────────────────────────────────────────────────
  async createProduct(request: FastifyRequest, reply: FastifyReply) {
    try {
      const vendorId = (request.user as any).vendorId;
      const body     = createProductSchema.parse(request.body);
      const product  = await productService.createProduct(vendorId, body);

      return reply.code(201).send({
        success: true,
        message: 'Product created successfully',
        data: product,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /products (public search) ─────────────────────────────────────────────
  async searchProducts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const filters = searchProductsSchema.parse(request.query);
      const data    = await productService.searchProducts(filters);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── GET /products/featured ────────────────────────────────────────────────────
  async getFeaturedProducts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { limit } = request.query as { limit?: string };
      const data      = await productService.getFeaturedProducts(limit ? parseInt(limit) : 8);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /products/me (vendor dashboard) ───────────────────────────────────────
  async getMyProducts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const vendorId = (request.user as any).vendorId;
      const data     = await productService.getMyProducts(vendorId);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /products/vendor/:vendorId (public vendor profile) ───────────────────
  async getVendorProducts(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { vendorId } = request.params as { vendorId: string };
      const data         = await productService.getVendorProducts(vendorId);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /products/slug/:slug ──────────────────────────────────────────────────
  async getBySlug(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { slug } = request.params as { slug: string };
      const data     = await productService.getProductBySlug(slug);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── GET /products/:id ─────────────────────────────────────────────────────────
  async getById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const data   = await productService.getProductById(id);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── PUT /products/:id ─────────────────────────────────────────────────────────
  async updateProduct(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }   = request.params as { id: string };
      const vendorId = (request.user as any).vendorId;
      const body     = updateProductSchema.parse(request.body);
      const data     = await productService.updateProduct(id, vendorId, body);

      return reply.code(200).send({
        success: true,
        message: 'Product updated successfully',
        data,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── PATCH /products/:id/status ────────────────────────────────────────────────
  async updateStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }   = request.params as { id: string };
      const vendorId = (request.user as any).vendorId;
      const { status } = updateProductStatusSchema.parse(request.body);
      const data     = await productService.updateProductStatus(id, vendorId, status);

      return reply.code(200).send({
        success: true,
        message: `Product ${status === 'active' ? 'published' : status} successfully`,
        data,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── PATCH /products/:id/inventory ─────────────────────────────────────────────
  async updateInventory(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }   = request.params as { id: string };
      const vendorId = (request.user as any).vendorId;
      const body     = updateInventorySchema.parse(request.body);
      const data     = await productService.updateInventory(id, vendorId, body);

      return reply.code(200).send({
        success: true,
        message: 'Inventory updated successfully',
        data,
      });
    } catch (error: any) {
      const isValidation = error?.name === 'ZodError';
      return reply.code(isValidation ? 422 : 400).send({
        success: false,
        error: isValidation ? error.errors : error.message,
      });
    }
  }

  // ── DELETE /products/:id ──────────────────────────────────────────────────────
  async deleteProduct(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id }   = request.params as { id: string };
      const vendorId = (request.user as any).vendorId;
      await productService.deleteProduct(id, vendorId);

      return reply.code(200).send({
        success: true,
        message: 'Product deleted successfully',
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}