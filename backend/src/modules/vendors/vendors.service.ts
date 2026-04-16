import { eq, and, desc } from 'drizzle-orm';
import { db }            from '../../config/database';
import { vendors, vendorDocuments } from '../../db/schema/vendors';
import { users }                    from '../../db/schema/users';
import { setCache, getCache, delCache } from '../../config/redis';
import { UploadResult }  from '../upload/upload.types';
import type {
  VendorApplicationInput, PayoutDetailsInput,
  UpdateVendorInput,      VendorReviewInput,
} from './vendors.schema';
import type { VendorFilters } from './vendors.types';

export class VendorService {

  private generateSlug(businessName: string): string {
    return businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + Date.now();
  }

  private invalidateCache(userId: string, vendorId?: string) {
    const ops = [delCache(`vendor:profile:${userId}`)];
    if (vendorId) ops.push(delCache(`vendor:public:${vendorId}`));
    return Promise.all(ops);
  }

  async applyAsVendor(userId: string, data: VendorApplicationInput) {
    const existing = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (existing) throw new Error('You already have a vendor application');

    const slug = this.generateSlug(data.businessName);

    const [vendor] = await db.insert(vendors).values({
      userId,
      businessName: data.businessName,
      slug,
      description:  data.description,
      phoneNumber:  data.phoneNumber,
      status:       'pending',
      verified:     false,
    }).returning();

    return vendor;
  }

  async getVendorProfile(userId: string) {
    const cacheKey = `vendor:profile:${userId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('Vendor profile not found. Please complete vendor registration first.');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  async updateVendorProfile(userId: string, data: UpdateVendorInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('Vendor profile not found');

    const updateData: Record<string, any> = { ...data, updatedAt: new Date() };
    if (data.businessName) updateData.slug = this.generateSlug(data.businessName);

    const [updated] = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, vendor.id))
      .returning();

    await this.invalidateCache(userId, vendor.id);
    return updated;
  }

  async addPayoutDetails(userId: string, data: PayoutDetailsInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('Vendor profile not found');

    const updateData: Record<string, any> = {
      payoutMethod: data.payoutMethod,
      updatedAt:    new Date(),
    };
    if (data.payoutMethod === 'mpesa') {
      updateData.mpesaNumber = data.mpesaNumber;
    } else {
      updateData.bankAccountName   = data.bankAccountName;
      updateData.bankAccountNumber = data.bankAccountNumber;
      updateData.bankName          = data.bankName;
    }

    const [updated] = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, vendor.id))
      .returning();

    await this.invalidateCache(userId);
    return updated;
  }

  async uploadVendorDocument(userId: string, documentType: string, uploadResult: UploadResult) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (!vendor) throw new Error('Vendor profile not found');

    const existing = await db.query.vendorDocuments.findFirst({
      where: and(
        eq(vendorDocuments.vendorId, vendor.id),
        eq(vendorDocuments.documentType, documentType),
      ),
    });

    if (existing) {
      const [updated] = await db.update(vendorDocuments)
        .set({
          documentUrl: uploadResult.url,
          fileName:    uploadResult.fileName,
          fileSize:    uploadResult.fileSize.toString(),
          uploadedAt:  new Date(),
        })
        .where(eq(vendorDocuments.id, existing.id))
        .returning();
      return updated;
    }

    const [doc] = await db.insert(vendorDocuments).values({
      vendorId:    vendor.id,
      documentType,
      documentUrl: uploadResult.url,
      fileName:    uploadResult.fileName,
      fileSize:    uploadResult.fileSize.toString(),
    }).returning();

    await this.invalidateCache(userId);
    return doc;
  }

  async getVendorDocuments(userId: string) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.userId, userId) });
    if (!vendor) throw new Error('Vendor profile not found');
    return db.query.vendorDocuments.findMany({
      where: eq(vendorDocuments.vendorId, vendor.id),
    });
  }

  async getPublicVendorProfile(vendorId: string) {
    const cacheKey = `vendor:public:${vendorId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor || vendor.status !== 'approved') throw new Error('Vendor not found');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  // ── Admin: get pending ────────────────────────────────────────────────────

  async getPendingVendors() {
    const rows = await db
      .select({
        id:           vendors.id,
        userId:       vendors.userId,
        businessName: vendors.businessName,
        description:  vendors.description,
        phoneNumber:  vendors.phoneNumber,
        city:         vendors.city,
        status:       vendors.status,
        verified:     vendors.verified,
        createdAt:    vendors.createdAt,
        userEmail:    users.email,
        userPhone:    users.phone,
        userFullName: users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(eq(vendors.status, 'pending'))
      .orderBy(desc(vendors.createdAt));

    return rows.map(r => ({
      id: r.id, userId: r.userId, businessName: r.businessName,
      description: r.description, phoneNumber: r.phoneNumber,
      city: r.city, status: r.status, verified: r.verified,
      createdAt: r.createdAt,
      user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName },
    }));
  }

  // ── Admin: get all vendors ────────────────────────────────────────────────

  async getAllVendors(filters?: VendorFilters) {
    const conditions: any[] = [];
    if (filters?.status) conditions.push(eq(vendors.status, filters.status as any));

    const rows = await db
      .select({
        id:           vendors.id,
        userId:       vendors.userId,
        businessName: vendors.businessName,
        description:  vendors.description,
        phoneNumber:  vendors.phoneNumber,
        city:         vendors.city,
        status:       vendors.status,
        verified:     vendors.verified,
        createdAt:    vendors.createdAt,
        userEmail:    users.email,
        userPhone:    users.phone,
        userFullName: users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(filters?.limit  ?? 50)
      .offset(filters?.offset ?? 0)
      .orderBy(desc(vendors.createdAt));

    return rows.map(r => ({
      id: r.id, userId: r.userId, businessName: r.businessName,
      description: r.description, phoneNumber: r.phoneNumber,
      city: r.city, status: r.status, verified: r.verified,
      createdAt: r.createdAt,
      user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName },
    }));
  }

  // ── Admin: get by ID ──────────────────────────────────────────────────────

  async getVendorById(vendorId: string) {
    const rows = await db
      .select({
        id:              vendors.id,
        userId:          vendors.userId,
        businessName:    vendors.businessName,
        description:     vendors.description,
        phoneNumber:     vendors.phoneNumber,
        city:            vendors.city,
        status:          vendors.status,
        verified:        vendors.verified,
        rejectionReason: vendors.rejectionReason,
        createdAt:       vendors.createdAt,
        userEmail:       users.email,
        userPhone:       users.phone,
        userFullName:    users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(eq(vendors.id, vendorId))
      .limit(1);

    if (!rows[0]) throw new Error('Vendor not found');
    const r = rows[0];
    return {
      ...r,
      user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName },
    };
  }

  // ── Admin: review ─────────────────────────────────────────────────────────

  async reviewVendorApplication(vendorId: string, adminId: string, data: VendorReviewInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw new Error('Vendor not found');

    const [updated] = await db.update(vendors)
      .set({
        status:          data.status,
        rejectionReason: data.rejectionReason ?? null,
        approvedBy:      data.status === 'approved' ? adminId : null,
        approvedAt:      data.status === 'approved' ? new Date() : null,
        updatedAt:       new Date(),
      })
      .where(eq(vendors.id, vendorId))
      .returning();

    // ✅ Sync user role
    const newRole = data.status === 'approved' ? 'vendor' : 'customer';
    await db.update(users)
      .set({ role: newRole })
      .where(eq(users.id, vendor.userId));

    await this.invalidateCache(vendor.userId, vendorId);
    return updated;
  }

  // ── Admin: suspend ────────────────────────────────────────────────────────

  async suspendVendor(vendorId: string, reason: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw new Error('Vendor not found');

    const [updated] = await db.update(vendors)
      .set({ status: 'suspended', rejectionReason: reason, updatedAt: new Date() })
      .where(eq(vendors.id, vendorId))
      .returning();

    await db.update(users)
      .set({ role: 'customer' })
      .where(eq(users.id, vendor.userId));

    await this.invalidateCache(vendor.userId, vendorId);
    return updated;
  }
}