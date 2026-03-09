export type ProductStatus = 'draft' | 'active' | 'paused' | 'out_of_stock' | 'deleted';

export interface ProductVariant {
  id: string | undefined;
  productId: string | undefined;
  name: string | undefined;
  price?: string | undefined;
  attributes?: Record<string, string>;
 createdAt: string | undefined;
}

export interface ProductInventory {
  id: string | undefined;
  productId: string | undefined;
  variantId?: string | undefined;
  quantity: number;
  lowStockAt: number;
  trackStock: boolean;
  updatedAt: string | undefined;
}

export interface ProductWithRelations {
  id: string;
  vendorId: string;
  categoryId?: string;
  title: string;
  slug: string;
  description?: string;
  price: string;
  currency: string;
  photos: string[];
  coverPhoto?: string;
  whatsappMessage?: string;
  isDigital: boolean;
  status: ProductStatus;
  views: number;
  createdAt: string;
  updatedAt: string;
  vendor?: {
    id: string;
    businessName: string;
    slug: string;
    logo?: string;
    whatsappNumber?: string;
    phoneNumber: string;
    verified: boolean;
  };
  category?: {
    id: string;
    name: string;
    slug: string;
    icon?: string;
  };
  variants?: ProductVariant[];
  inventory?: ProductInventory[];
}

export interface ProductFilters {
  categoryId?:   string | undefined;
  categorySlug?: string | undefined;
  vendorId?:     string | undefined;
  search?:       string | undefined;
  minPrice?:     number | undefined;
  maxPrice?:     number | undefined;
  isDigital?:    boolean | undefined;
  status?:       ProductStatus;
  limit?:        number | undefined;
  offset?:       number | undefined;
  sortBy?:       'price' | 'newest' | 'popular';
}