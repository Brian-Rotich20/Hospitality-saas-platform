import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';

// Import individually — barrel import (index.ts) causes circular deps with Drizzle
import * as usersSchema        from '../db/schema/users';
import * as vendorsSchema      from '../db/schema/vendors';
import * as listingsSchema     from '../db/schema/listings';
import * as availabilitySchema from '../db/schema/availability';
import * as bookingsSchema     from '../db/schema/bookings';
import * as paymentsSchema     from '../db/schema/payments';
import * as payoutsSchema      from '../db/schema/payouts';
import * as categoriesSchema   from '../db/schema/categories';
import * as productsSchema     from '../db/schema/products';

const schema = {
  ...usersSchema,
  ...vendorsSchema,
  ...listingsSchema,
  ...availabilitySchema,
  ...bookingsSchema,
  ...paymentsSchema,
  ...payoutsSchema,
  ...categoriesSchema,
  ...productsSchema,
};

const client = postgres(env.DATABASE_URL);
export const db = drizzle(client, { schema });