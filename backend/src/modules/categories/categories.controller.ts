import { FastifyRequest, FastifyReply } from 'fastify';
import { CategoryService } from './categories.service.js';
import { createCategorySchema, updateCategorySchema } from './categories.schema.js';

const categoryService = new CategoryService();

export class CategoryController {

  // ── GET /categories ───────────────────────────────────────────────────────────
  // Returns top-level categories — used by store header strip
  async getTopLevel(request: FastifyRequest, reply: FastifyReply) {
    try {
      const data = await categoryService.getTopLevelCategories();
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /categories/tree ──────────────────────────────────────────────────────
  // Returns full nested tree — used by listing creation form dropdowns
  async getTree(request: FastifyRequest, reply: FastifyReply) {
    try {
      const data = await categoryService.getCategoryTree();
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /categories/:id/subcategories ─────────────────────────────────────────
  async getSubcategories(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const data   = await categoryService.getSubcategories(id);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }

  // ── GET /categories/slug/:slug ────────────────────────────────────────────────
  async getBySlug(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { slug } = request.params as { slug: string };
      const data     = await categoryService.getCategoryBySlug(slug);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── GET /categories/:id ───────────────────────────────────────────────────────
  async getById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const data   = await categoryService.getCategoryById(id);
      return reply.code(200).send({ success: true, data });
    } catch (error: any) {
      return reply.code(404).send({ success: false, error: error.message });
    }
  }

  // ── Admin: POST /admin/categories ─────────────────────────────────────────────
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = createCategorySchema.parse(request.body);
      const data = await categoryService.createCategory(body);
      return reply.code(201).send({
        success: true,
        message: 'Category created successfully',
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

  // ── Admin: PUT /admin/categories/:id ──────────────────────────────────────────
  async update(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const body   = updateCategorySchema.parse(request.body);
      const data   = await categoryService.updateCategory(id, body);
      return reply.code(200).send({
        success: true,
        message: 'Category updated successfully',
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

  // ── Admin: DELETE /admin/categories/:id ───────────────────────────────────────
  async delete(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      await categoryService.deleteCategory(id);
      return reply.code(200).send({
        success: true,
        message: 'Category deleted successfully',
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  }
}