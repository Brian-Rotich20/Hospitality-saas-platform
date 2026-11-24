import { asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/database/client.js';
import { categories } from '../../platform/database/schema/categories.js';
import { listings } from '../../platform/database/schema/listings.js';
import { cache } from '../../platform/cache/redis.js';
import { ConflictError, NotFoundError, ValidationError } from '../../app/errors.js';

export type CategoryRow = typeof categories.$inferSelect;
type Tree = CategoryRow & { children: Tree[] };

const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const key = async (suffix: string) => `categories:${await cache.version('categories')}:${suffix}`;

async function cached<T>(suffix: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const k = await key(suffix);
  const hit = await cache.get<T>(k);
  if (hit) return hit;
  const value = await load();
  await cache.set(k, value, ttl);
  return value;
}

async function invalidate() {
  await cache.bump('categories');
  await cache.bump('catalog');
}

export const categoriesService = {
  topLevel: () => cached('top', 3600, () => db.query.categories.findMany({ where: isNull(categories.parentId), orderBy: [asc(categories.name)] })),

  tree: () => cached('tree', 3600, async () => {
    const all = await db.query.categories.findMany({ orderBy: [asc(categories.name)] });
    const byId = new Map<string, Tree>(all.map((c) => [c.id, { ...c, children: [] }]));
    const roots: Tree[] = [];
    for (const c of all) {
      const node = byId.get(c.id)!;
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }),

  children: (parentId: string) => cached(`children:${parentId}`, 3600, () =>
    db.query.categories.findMany({ where: eq(categories.parentId, parentId), orderBy: [asc(categories.name)] })),

  async byId(id: string) {
    const row = await db.query.categories.findFirst({ where: eq(categories.id, id), with: { children: true } });
    if (!row) throw new NotFoundError('Category');
    return row;
  },

  bySlug: (slug: string) => cached(`slug:${slug}`, 3600, async () => {
    const row = await db.query.categories.findFirst({ where: eq(categories.slug, slug), with: { children: true } });
    if (!row) throw new NotFoundError('Category');
    return row;
  }),

  async create(input: { name: string; slug?: string | undefined; icon?: string | undefined; imageUrl?: string | undefined; parentId?: string | undefined }) {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw new ValidationError('Could not derive a slug from the name; provide one');
    if (await db.query.categories.findFirst({ where: eq(categories.slug, slug), columns: { id: true } })) {
      throw new ConflictError(`Slug '${slug}' is already taken`, 'SLUG_TAKEN');
    }
    if (input.parentId && !(await db.query.categories.findFirst({ where: eq(categories.id, input.parentId), columns: { id: true } }))) {
      throw new ValidationError('Parent category not found');
    }
    const [row] = await db.insert(categories).values({ name: input.name, slug, icon: input.icon, imageUrl: input.imageUrl, parentId: input.parentId }).returning();
    await invalidate();
    return row;
  },

  async update(id: string, input: { name?: string | undefined; slug?: string | undefined; icon?: string | undefined; imageUrl?: string | undefined; parentId?: string | null | undefined }) {
    const current = await db.query.categories.findFirst({ where: eq(categories.id, id) });
    if (!current) throw new NotFoundError('Category');
    if (input.parentId) {
      if (input.parentId === id) throw new ValidationError('A category cannot be its own parent');
      // Reject cycles: the new parent must not be a descendant of this category.
      const rows = await db.execute(sql`
        WITH RECURSIVE up(id, parent_id) AS (
          SELECT id, parent_id FROM categories WHERE id = ${input.parentId}
          UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN up ON c.id = up.parent_id
        ) SELECT 1 FROM up WHERE id = ${id} LIMIT 1`) as unknown[];
      if (rows.length > 0) throw new ValidationError('That parent would create a cycle');
    }
    const slug = input.slug ?? (input.name ? slugify(input.name) : undefined);
    const [row] = await db.update(categories).set({
      ...(input.name !== undefined && { name: input.name }),
      ...(slug !== undefined && { slug }),
      ...(input.icon !== undefined && { icon: input.icon }),
      ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      updatedAt: new Date(),
    }).where(eq(categories.id, id)).returning();
    await invalidate();
    return row;
  },

  async remove(id: string) {
    const kids = await db.query.categories.findMany({ where: eq(categories.parentId, id), columns: { id: true } });
    if (kids.length) throw new ConflictError(`This category has ${kids.length} subcategories. Delete or reassign them first.`, 'CATEGORY_HAS_CHILDREN');
    const used = await db.query.listings.findFirst({ where: eq(listings.categoryId, id), columns: { id: true } });
    if (used) throw new ConflictError('Listings use this category. Reassign them first.', 'CATEGORY_IN_USE');
    const [row] = await db.delete(categories).where(eq(categories.id, id)).returning();
    if (!row) throw new NotFoundError('Category');
    await invalidate();
  },
};
