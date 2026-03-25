import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';

// Individual imports — no barrel (index.ts causes circular dep issues with Drizzle)
import { users }                            from '../db/schema/users';
import { vendors, vendorDocuments }         from '../db/schema/vendors';
import { categories }                       from '../db/schema/categories';
import { listings }                         from '../db/schema/listings';
import { bookings }                         from '../db/schema/bookings';
import { payments }                         from '../db/schema/payments';
import { payouts }                          from '../db/schema/payouts';
import { products }                         from '../db/schema/products';
import { availability }                     from '../db/schema/availability';

const schema = {
  users,
  vendors,
  vendorDocuments,
  categories,
  listings,
  bookings,
  payments,
  payouts,
  products,
  availability,
};

const client = postgres(env.DATABASE_URL);
export const db = drizzle(client, { schema });

// Temporary debug — remove after confirming fix
console.log('[DB] registered query tables:', Object.keys(db.query ?? {}));