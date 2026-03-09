export interface Category {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  parentId?: string;
  children?: Category[];
  createdAt: string;
}

export interface CategoryFilters {
  parentId?: string;  // null = top-level only, uuid = children of that parent
  withChildren?: boolean;
}