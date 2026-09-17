import { eq, and, desc } from 'drizzle-orm';
import { db }            from '../../config/database.js';
import { vendors }       from '../../db/schema/vendors.js';
import { users }         from '../../db/schema/users.js';
import { setCache, getCache, delCache } from '../../config/redis.js';
import type { PayoutDetailsInput, UpdateVendorInput } from './vendors.schema.js';
import type { VendorFilters } from './vendors.types.js';

export class VendorService {

  private generateSlug(businessName: string): string {
    return businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  }

  private invalidateCache(userId: string, vendorId?: string) {
    const ops = [delCache(`vendor:profile:${userId}`)];
    if (vendorId) ops.push(delCache(`vendor:public:${vendorId}`));
    return Promise.all(ops);
  }

  // ── Become a vendor — instant, pre-filled from user data ────────────────────
  async becomeVendor(userId: string) {
    const existing = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (existing) return existing; // idempotent — no error if they hit this twice

    const user = await db.query.users.findFirst({
      where:   eq(users.id, userId),
      columns: { id: true, fullName: true, phone: true },
    });
    if (!user) throw new Error('User not found');

    const businessName = user.fullName || 'My Shop';
    const slug          = this.generateSlug(businessName);

    const [vendor] = await db.insert(vendors).values({
      userId,
      businessName,
      slug,
      phoneNumber: user.phone,
      status:      'approved',
      verified:    false,
    }).returning();

    if (!vendor) throw new Error('Failed to set up vendor account. Please try again.');

    await db.update(users)
      .set({ role: 'vendor', vendorId: vendor.id, updatedAt: new Date() })
      .where(eq(users.id, userId));

    return vendor;
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  isProfileComplete(vendor: any): { complete: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!vendor.logo)        missing.push('logo');
    if (!vendor.phoneNumber) missing.push('phone number');
    return { complete: missing.length === 0, missing };
  }

  async getVendorProfile(userId: string) {
    const cacheKey = `vendor:profile:${userId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (!vendor) throw new Error('Vendor profile not found');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  async updateVendorProfile(userId: string, data: UpdateVendorInput) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (!vendor) throw new Error('Vendor profile not found');

    const updateData: Record<string, any> = { ...data, updatedAt: new Date() };
    if (data.businessName) updateData.slug = this.generateSlug(data.businessName);

    const [updated] = await db.update(vendors).set(updateData).where(eq(vendors.id, vendor.id)).returning();
    await this.invalidateCache(userId, vendor.id);
    return updated;
  }

  async addPayoutDetails(userId: string, data: PayoutDetailsInput) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (!vendor) throw new Error('Vendor profile not found');

    const updateData: Record<string, any> = { payoutMethod: data.payoutMethod, updatedAt: new Date() };
    if (data.payoutMethod === 'mpesa') {
      updateData.mpesaNumber = data.mpesaNumber;
    } else {
      updateData.bankAccountName   = data.bankAccountName;
      updateData.bankAccountNumber = data.bankAccountNumber;
      updateData.bankName          = data.bankName;
    }

    const [updated] = await db.update(vendors).set(updateData).where(eq(vendors.id, vendor.id)).returning();
    await this.invalidateCache(userId, vendor.id);
    return updated;
  }

  async getPublicVendorProfile(vendorId: string) {
    const cacheKey = `vendor:public:${vendorId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!vendor || vendor.status !== 'approved') throw new Error('Vendor not found');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async getAllVendors(filters?: VendorFilters) {
    const conditions: any[] = [];
    if (filters?.status) conditions.push(eq(vendors.status, filters.status as any));

    const rows = await db.select({
      id: vendors.id, userId: vendors.userId, businessName: vendors.businessName,
      phoneNumber: vendors.phoneNumber, status: vendors.status, verified: vendors.verified,
      createdAt: vendors.createdAt,
      userEmail: users.email, userPhone: users.phone, userFullName: users.fullName,
    }).from(vendors).leftJoin(users, eq(users.id, vendors.userId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(filters?.limit ?? 50).offset(filters?.offset ?? 0).orderBy(desc(vendors.createdAt));
    return rows.map(r => ({ ...r, user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName } }));
  }

  async suspendVendor(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!vendor) throw new Error('Vendor not found');

    const [updated] = await db.update(vendors)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(vendors.id, vendorId)).returning();

    await db.update(users).set({ role: 'customer' }).where(eq(users.id, vendor.userId));
    await this.invalidateCache(vendor.userId, vendorId);
    return updated;
  }

  async getVendorById(vendorId: string) {
    const rows = await db.select({
      id: vendors.id, userId: vendors.userId, businessName: vendors.businessName,
      phoneNumber: vendors.phoneNumber, status: vendors.status, verified: vendors.verified,
      createdAt: vendors.createdAt,
      userEmail: users.email, userPhone: users.phone, userFullName: users.fullName,
    }).from(vendors).leftJoin(users, eq(users.id, vendors.userId))
      .where(eq(vendors.id, vendorId)).limit(1);

    if (!rows[0]) throw new Error('Vendor not found');
    const r = rows[0];
    return { ...r, user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName } };
  }
}