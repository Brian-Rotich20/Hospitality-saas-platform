import { eq, and, or, gte, lte, ilike, sql, desc, asc } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { products, productVariants, productInventory, vendors, categories } from '../../db/schema/index.js';
import { getCache, setCache, delCache } from '../../config/redis.js';
import type { ProductFilters } from './products.types.js';
import type {
  CreateProductInput,
  UpdateProductInput,
  UpdateInventoryInput,
} from './products.schema.js';

export class ProductService {

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + Date.now();
  }

  private async invalidateProductCache(productId: string, slug?: string) {
    const ops = [
      delCache(`product:${productId}`),
      delCache('products:featured'),
    ];
    if (slug) ops.push(delCache(`product:slug:${slug}`));
    await Promise.all(ops);
  }

  private async getApprovedVendor(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor)                          throw new Error('Vendor not found');
    if (vendor.status !== 'approved')     throw new Error('Only approved vendors can manage products');
    return vendor;
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  async createProduct(vendorId: string, data: CreateProductInput) {
    await this.getApprovedVendor(vendorId);

    // Validate category if provided
    if (data.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, data.categoryId),
      });
      if (!cat) throw new Error('Invalid category');
    }

    const slug       = this.generateSlug(data.title);
    const coverPhoto = data.coverPhoto ?? data.photos?.[0];

    // Build default WhatsApp message if not provided
    const whatsappMessage = data.whatsappMessage
      ?? `Hi, I'm interested in your product: ${data.title}. Is it available?`;

    const [product] = await db.insert(products).values({
      vendorId,
      categoryId:      data.categoryId,
      title:           data.title,
      slug,
      description:     data.description,
      price:           data.price.toString(),
      currency:        data.currency ?? 'KES',
      photos:          data.photos ?? [],
      coverPhoto,
      whatsappMessage,
      isDigital:       data.isDigital ?? false,
      status:          'draft',
    }).returning();

    if (!product) throw new Error('Failed to create product');

    // Create variants if provided
    if (data.variants?.length) {
      await db.insert(productVariants).values(
        data.variants.map(v => ({
          productId:  product.id,
          name:       v.name,
          price:      v.price?.toString(),
          attributes: (v.attributes ?? {}) as Record<string, string>,
        }))
      );
    }

    // Create inventory record if stock tracking enabled
    if (data.trackStock) {
      await db.insert(productInventory).values({
        productId:  product.id,
        quantity:   data.quantity ?? 0,
        lowStockAt: data.lowStockAt ?? 5,
        trackStock: true,
      });
    }

    return this.getProductById(product.id);
  }

  // ── Read: by ID ───────────────────────────────────────────────────────────────

  async getProductById(productId: string) {
    const cacheKey = `product:${productId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
      with: {
        vendor: {
          columns: {
            id: true, businessName: true, slug: true,
            logo: true, whatsappNumber: true, phoneNumber: true, verified: true,
          },
        },
        category:  { columns: { id: true, name: true, slug: true, icon: true } },
        variants:  true,
        inventory: true,
      },
    });

    if (!product || product.status === 'deleted') throw new Error('Product not found');

    // Increment views async
    db.update(products)
      .set({ views: sql`${products.views} + 1` })
      .where(eq(products.id, productId))
      .execute();

    await setCache(cacheKey, product, 600);
    return product;
  }

  // ── Read: by slug ─────────────────────────────────────────────────────────────

  async getProductBySlug(slug: string) {
    const cacheKey = `product:slug:${slug}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const product = await db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: {
        vendor: {
          columns: {
            id: true, businessName: true, slug: true,
            logo: true, whatsappNumber: true, phoneNumber: true, verified: true,
          },
        },
        category:  { columns: { id: true, name: true, slug: true, icon: true } },
        variants:  true,
        inventory: true,
      },
    });

    if (!product || product.status === 'deleted') throw new Error('Product not found');

    db.update(products)
      .set({ views: sql`${products.views} + 1` })
      .where(eq(products.id, product.id))
      .execute();

    await setCache(cacheKey, product, 600);
    return product;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async updateProduct(productId: string, vendorId: string, data: UpdateProductInput) {
    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    if (!product)                        throw new Error('Product not found');
    if (product.vendorId !== vendorId)   throw new Error('Unauthorized');

    if (data.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, data.categoryId),
      });
      if (!cat) throw new Error('Invalid category');
    }

    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (data.title)           { updateData.title = data.title; updateData.slug = this.generateSlug(data.title); }
    if (data.description)     updateData.description     = data.description;
    if (data.categoryId)      updateData.categoryId      = data.categoryId;
    if (data.price != null)   updateData.price           = data.price.toString();
    if (data.currency)        updateData.currency        = data.currency;
    if (data.photos)          updateData.photos          = data.photos;
    if (data.coverPhoto)      updateData.coverPhoto      = data.coverPhoto;
    if (data.whatsappMessage) updateData.whatsappMessage = data.whatsappMessage;
    if (data.isDigital != null) updateData.isDigital     = data.isDigital;

    const [updated] = await db.update(products)
      .set(updateData)
      .where(eq(products.id, productId))
      .returning();

    await this.invalidateProductCache(productId, product.slug);
    return updated;
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  async updateProductStatus(productId: string, vendorId: string, status: 'draft' | 'active' | 'paused' | 'out_of_stock' | 'deleted') {
    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    if (!product)                      throw new Error('Product not found');
    if (product.vendorId !== vendorId) throw new Error('Unauthorized');

    if (status === 'active') {
      if (!product.photos || (product.photos as string[]).length === 0)
        throw new Error('Add at least one photo before publishing');
      if (!product.price || parseFloat(product.price) <= 0)
        throw new Error('Set a valid price before publishing');
    }

    const [updated] = await db.update(products)
      .set({ status, updatedAt: new Date() })
      .where(eq(products.id, productId))
      .returning();

    await this.invalidateProductCache(productId);
    return updated;
  }

  // ── Delete (soft) ─────────────────────────────────────────────────────────────

  async deleteProduct(productId: string, vendorId: string) {
    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    if (!product)                      throw new Error('Product not found');
    if (product.vendorId !== vendorId) throw new Error('Unauthorized');

    const [deleted] = await db.update(products)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(eq(products.id, productId))
      .returning();

    await this.invalidateProductCache(productId, product.slug);
    return deleted;
  }

  // ── Search (public) ───────────────────────────────────────────────────────────

  async searchProducts(filters: ProductFilters) {
    const cacheKey = `products:search:${JSON.stringify(filters)}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const conditions: any[] = [eq(products.status, 'active')];

    if (filters.categoryId) {
      conditions.push(eq(products.categoryId, filters.categoryId));
    } else if (filters.categorySlug) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.slug, filters.categorySlug),
      });
      if (cat) conditions.push(eq(products.categoryId, cat.id));
    }

    if (filters.vendorId) {
      conditions.push(eq(products.vendorId, filters.vendorId));
    }

    if (filters.isDigital != null) {
      conditions.push(eq(products.isDigital, filters.isDigital));
    }

    if (filters.minPrice) {
      conditions.push(gte(products.price, filters.minPrice.toString()));
    }
    if (filters.maxPrice) {
      conditions.push(lte(products.price, filters.maxPrice.toString()));
    }

    if (filters.search) {
      conditions.push(
        or(
          ilike(products.title,       `%${filters.search}%`),
          ilike(products.description, `%${filters.search}%`),
        )
      );
    }

    const orderBy = (() => {
      switch (filters.sortBy) {
        case 'price':   return [asc(products.price)];
        case 'popular': return [desc(products.views)];
        default:        return [desc(products.createdAt)];
      }
    })();

    const results = await db.query.products.findMany({
      where:   and(...conditions),
      with: {
        vendor: {
          columns: { id: true, businessName: true, slug: true, logo: true, verified: true, whatsappNumber: true },
        },
        category:  { columns: { id: true, name: true, slug: true, icon: true } },
        variants:  true,
        inventory: true,
      },
      orderBy,
      limit:  filters.limit  ?? 20,
      offset: filters.offset ?? 0,
    });

    await setCache(cacheKey, results, 300);
    return results;
  }

  // ── My products (vendor dashboard) ───────────────────────────────────────────

  async getMyProducts(vendorId: string) {
    return db.query.products.findMany({
      where: and(
        eq(products.vendorId, vendorId),
        sql`${products.status} != 'deleted'`,
      ),
      with: {
        category:  { columns: { id: true, name: true, slug: true, icon: true } },
        variants:  true,
        inventory: true,
      },
      orderBy: [desc(products.updatedAt)],
    });
  }

  // ── Inventory update ──────────────────────────────────────────────────────────

  async updateInventory(productId: string, vendorId: string, data: UpdateInventoryInput) {
    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    if (!product)                      throw new Error('Product not found');
    if (product.vendorId !== vendorId) throw new Error('Unauthorized');

    const existing = await db.query.productInventory.findFirst({
      where: eq(productInventory.productId, productId),
    });

    if (existing) {
      const [updated] = await db.update(productInventory)
        .set({
          quantity:   data.quantity,
          lowStockAt: data.lowStockAt ?? existing.lowStockAt,
          trackStock: data.trackStock ?? existing.trackStock,
          updatedAt:  new Date(),
        })
        .where(eq(productInventory.productId, productId))
        .returning();
      return updated;
    }

    // Create inventory record if it doesn't exist
    const [created] = await db.insert(productInventory).values({
      productId,
      quantity:   data.quantity,
      lowStockAt: data.lowStockAt ?? 5,
      trackStock: data.trackStock ?? true,
    }).returning();

    await this.invalidateProductCache(productId);
    return created;
  }

  // ── Featured products (homepage) ──────────────────────────────────────────────

  async getFeaturedProducts(limit = 8) {
    const cacheKey = `products:featured:${limit}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const result = await db.query.products.findMany({
      where: eq(products.status, 'active'),
      with: {
        vendor:   { columns: { id: true, businessName: true, slug: true, logo: true, verified: true, whatsappNumber: true } },
        category: { columns: { id: true, name: true, slug: true, icon: true } },
        variants: true,
      },
      orderBy: [desc(products.views)],
      limit,
    });

    await setCache(cacheKey, result, 3600);
    return result;
  }

  // ── Vendor's public products (for vendor profile page) ────────────────────────

  async getVendorProducts(vendorId: string) {
    return db.query.products.findMany({
      where: and(
        eq(products.vendorId, vendorId),
        eq(products.status, 'active'),
      ),
      with: {
        category: { columns: { id: true, name: true, slug: true, icon: true } },
        variants: true,
      },
      orderBy: [desc(products.createdAt)],
    });
  }
}