import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env.js';

// Import individually — barrel import (index.ts) causes circular deps with Drizzle
import * as usersSchema        from '../db/schema/users.js';
import * as vendorsSchema      from '../db/schema/vendors.js';
import * as listingsSchema     from '../db/schema/listings.js';
import * as availabilitySchema from '../db/schema/availability.js';
import * as bookingsSchema     from '../db/schema/bookings.js';
import * as paymentsSchema     from '../db/schema/payments.js';
import * as payoutsSchema      from '../db/schema/payouts.js';
import * as categoriesSchema   from '../db/schema/categories.js';
import * as productsSchema     from '../db/schema/products.js';
import * as reviewsSchema      from '../db/schema/reviews.js';
import * as savedListingsSchema from '../db/schema/savedListings.js';

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
  ...reviewsSchema,
  ...savedListingsSchema,
};

const client = postgres(env.DATABASE_URL);
export const db = drizzle(client, { schema });