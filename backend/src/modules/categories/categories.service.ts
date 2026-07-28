import { eq, isNull, and } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { categories } from '../../db/schema/index.js';
import { getCache, setCache, delCache } from '../../config/redis.js';
import type { CreateCategoryInput, UpdateCategoryInput } from './categories.schema.js';

export class CategoryService {

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async invalidateCache() {
    await Promise.all([
      delCache('categories:all'),
      delCache('categories:top-level'),
      delCache('categories:tree'),
    ]);
  }

  // ── Get all top-level categories (for nav/header strip) ───────────────────────
  // Returns only parent categories — fastest query for the store header

  async getTopLevelCategories() {
    const cacheKey = 'categories:top-level';
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const result = await db.query.categories.findMany({
      where: isNull(categories.parentId),
      orderBy: (categories, { asc }) => [asc(categories.name)],
    });

    await setCache(cacheKey, result, 3600); // 1 hour — categories rarely change
    return result;
  }

  // ── Get full tree (top-level + children nested) ───────────────────────────────
  // Used for dropdown menus, listing creation form

  async getCategoryTree() {
    const cacheKey = 'categories:tree';
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    // Fetch everything in one query then nest in JS — faster than recursive SQL
    const all = await db.query.categories.findMany({
      orderBy: (categories, { asc }) => [asc(categories.name)],
    });

    // Build tree
    const map = new Map<string, any>();
    const roots: any[] = [];

    all.forEach(cat => map.set(cat.id, { ...cat, children: [] }));

    all.forEach(cat => {
      if (cat.parentId) {
        const parent = map.get(cat.parentId);
        if (parent) parent.children.push(map.get(cat.id));
      } else {
        roots.push(map.get(cat.id));
      }
    });

    await setCache(cacheKey, roots, 3600);
    return roots;
  }

  // ── Get children of a category ────────────────────────────────────────────────

  async getSubcategories(parentId: string) {
    const cacheKey = `categories:children:${parentId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const result = await db.query.categories.findMany({
      where: eq(categories.parentId, parentId),
      orderBy: (categories, { asc }) => [asc(categories.name)],
    });

    await setCache(cacheKey, result, 3600);
    return result;
  }

  // ── Get single category by ID or slug ────────────────────────────────────────

  async getCategoryById(id: string) {
    const result = await db.query.categories.findFirst({
      where: eq(categories.id, id),
      with: { children: true },
    });
    if (!result) throw new Error('Category not found');
    return result;
  }

  async getCategoryBySlug(slug: string) {
    const cacheKey = `categories:slug:${slug}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const result = await db.query.categories.findFirst({
      where: eq(categories.slug, slug),
      with: { children: true },
    });
    if (!result) throw new Error('Category not found');

    await setCache(cacheKey, result, 3600);
    return result;
  }

  // ── Admin: Create ─────────────────────────────────────────────────────────────

  async createCategory(data: CreateCategoryInput) {
    const slug = data.slug ?? this.generateSlug(data.name);

    // Check slug is unique
    const existing = await db.query.categories.findFirst({
      where: eq(categories.slug, slug),
    });
    if (existing) throw new Error(`Slug '${slug}' is already taken`);

    // Validate parent exists if provided
    if (data.parentId) {
      const parent = await db.query.categories.findFirst({
        where: eq(categories.id, data.parentId),
      });
      if (!parent) throw new Error('Parent category not found');
    }

    const [category] = await db.insert(categories).values({
      name:     data.name,
      slug,
      icon:     data.icon,
      imageUrl: data.imageUrl,
      parentId: data.parentId,
    }).returning();

    await this.invalidateCache();
    return category;
  }

  // ── Admin: Update ─────────────────────────────────────────────────────────────

  async updateCategory(id: string, data: UpdateCategoryInput) {
    const existing = await db.query.categories.findFirst({
      where: eq(categories.id, id),
    });
    if (!existing) throw new Error('Category not found');

    const updateData: Record<string, any> = {};
    if (data.name)     updateData.name     = data.name;
    if (data.icon)     updateData.icon     = data.icon;
    if (data.parentId) updateData.parentId = data.parentId;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;

    // Regenerate slug only if name changed and no explicit slug provided
    if (data.name && !data.slug) {
      updateData.slug = this.generateSlug(data.name);
    } else if (data.slug) {
      updateData.slug = data.slug;
    }

    const [updated] = await db.update(categories)
      .set(updateData)
      .where(eq(categories.id, id))
      .returning();

    await this.invalidateCache();
    await delCache(`categories:slug:${existing.slug}`);
    return updated;
  }

  // ── Admin: Delete ─────────────────────────────────────────────────────────────

  async deleteCategory(id: string) {
    // Check for children — don't delete a parent with subcategories
    const children = await db.query.categories.findMany({
      where: eq(categories.parentId, id),
    });
    if (children.length > 0) {
      throw new Error(`Cannot delete: this category has ${children.length} subcategories. Delete or reassign them first.`);
    }

    const [deleted] = await db.delete(categories)
      .where(eq(categories.id, id))
      .returning();

    if (!deleted) throw new Error('Category not found');

    await this.invalidateCache();
    await delCache(`categories:slug:${deleted.slug}`);
    return deleted;
  }
}