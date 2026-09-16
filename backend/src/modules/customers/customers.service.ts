import { eq, and, desc } from 'drizzle-orm';       
import { db } from '../../config/database.js';
import { users } from '../../db/schema/users.js';
import {CustomerFilters} from './customers.types.js';


export class CustomerService {
  async getAllCustomers(filters?: CustomerFilters) {
    const limit = filters?.limit ?? 50;
    const offset = ((filters?.page ?? 1) - 1) * limit;

    return db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        avatarUrl: users.avatarUrl,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.role, 'customer'))
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
  }
}