import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db, type Db } from '../../platform/database/client.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { users } from '../../platform/database/schema/users.js';

export type VendorRow = typeof vendors.$inferSelect;
export type VendorStatus = VendorRow['status'];

/**
 * Fields safe to show anyone: the business identity and its public contact (business email,
 * phone, WhatsApp). The owner's login email, payout details, user linkage and admin fields
 * are excluded.
 */
export const publicVendorColumns = {
  id: true, businessName: true, slug: true, logo: true, phoneNumber: true, businessEmail: true, whatsappNumber: true,
  verified: true, createdAt: true,
} as const;

export const vendorsRepo = {
  findById(id: string, tx: Db = db) {
    return tx.query.vendors.findFirst({ where: eq(vendors.id, id) });
  },

  findByUserId(userId: string, tx: Db = db) {
    return tx.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
  },

  findPublic(id: string) {
    return db.query.vendors.findFirst({
      where: and(eq(vendors.id, id), eq(vendors.status, 'approved')),
      columns: publicVendorColumns,
    });
  },

  async insert(values: typeof vendors.$inferInsert, tx: Db) {
    const [row] = await tx.insert(vendors).values(values).returning();
    if (!row) throw new Error('vendor insert returned no row');
    return row;
  },

  async update(id: string, values: Partial<typeof vendors.$inferInsert>, tx: Db = db) {
    const [row] = await tx.update(vendors).set({ ...values, updatedAt: new Date() }).where(eq(vendors.id, id)).returning();
    return row;
  },

  /** Lock the vendor row for a state change. */
  async lock(id: string, tx: Db) {
    const [row] = await tx.select().from(vendors).where(eq(vendors.id, id)).for('update');
    return row;
  },

  listForAdmin(filter: { status?: VendorStatus | undefined; limit: number; offset: number }) {
    const where: SQL | undefined = filter.status ? eq(vendors.status, filter.status) : undefined;
    return db.select({
      id: vendors.id, userId: vendors.userId, businessName: vendors.businessName, slug: vendors.slug,
      phoneNumber: vendors.phoneNumber, status: vendors.status, verified: vendors.verified, createdAt: vendors.createdAt,
      userEmail: users.email, userFullName: users.fullName, userPhone: users.phone,
    })
      .from(vendors).innerJoin(users, eq(users.id, vendors.userId))
      .where(where).orderBy(desc(vendors.createdAt)).limit(filter.limit).offset(filter.offset);
  },
};
