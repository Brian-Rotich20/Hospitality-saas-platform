import { eq, and } from 'drizzle-orm';
import { db } from '../../config/database';
import { vendors, vendorDocuments, users } from '../../db/schema';
import { setCache, getCache, delCache } from '../../config/redis';
import { UploadResult } from '../upload/upload.types';
import type {
  VendorApplicationInput,
  PayoutDetailsInput,
  UpdateVendorInput,
  VendorReviewInput,
} from './vendors.schema';
import type { VendorFilters } from './vendors.types';

export class VendorService {

  // ── Helpers ──────────────────────────────────────────────────────────────────

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

  // ── Apply as vendor ───────────────────────────────────────────────────────────

  async applyAsVendor(userId: string, data: VendorApplicationInput) {
    const existing = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (existing) throw new Error('You already have a vendor application');

    // Update user role immediately
    await db.update(users)
      .set({ role: 'vendor' })
      .where(eq(users.id, userId));

    const slug = this.generateSlug(data.businessName);

    const [vendor] = await db.insert(vendors).values({
      userId,
      businessName:         data.businessName,
      slug,
      description:          data.description,
      phoneNumber:          data.phoneNumber,
      whatsappNumber:       data.whatsappNumber,
      businessRegistration: data.businessRegistration,
      taxPin:               data.taxPin,
      city:                 data.city,
      county:               data.county,
      email:                data.email,
      website:              data.website,
      status:               'pending',
      verified:             false,
    }).returning();

    // TODO: Notify admin for review
    // TODO: Send confirmation email/SMS to vendor

    return vendor;
  }

  // ── Get my profile ────────────────────────────────────────────────────────────

  async getVendorProfile(userId: string) {
    const cacheKey = `vendor:profile:${userId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
      with: {
        documents: true,
        user: {
          columns: { email: true, phone: true, verified: true, fullName: true },
        },
      },
    });

    if (!vendor) throw new Error('Vendor profile not found');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  // ── Update profile ────────────────────────────────────────────────────────────

  async updateVendorProfile(userId: string, data: UpdateVendorInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('Vendor profile not found');

    // Regenerate slug only if businessName changed
    const updateData: Record<string, any> = { ...data, updatedAt: new Date() };
    if (data.businessName) {
      updateData.slug = this.generateSlug(data.businessName);
    }

    const [updated] = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, vendor.id))
      .returning();

    await this.invalidateCache(userId, vendor.id);
    return updated;
  }

  // ── Payout details ────────────────────────────────────────────────────────────

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

  // ── Documents ─────────────────────────────────────────────────────────────────

  async uploadVendorDocument(userId: string, documentType: string, uploadResult: UploadResult) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
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
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('Vendor profile not found');

    return db.query.vendorDocuments.findMany({
      where: eq(vendorDocuments.vendorId, vendor.id),
    });
  }

  // ── Public vendor page ────────────────────────────────────────────────────────

  async getPublicVendorProfile(vendorId: string) {
    const cacheKey = `vendor:public:${vendorId}`;
    const cached   = await getCache(cacheKey);
    if (cached) return cached;

    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
      with: {
        user: {
          columns: { fullName: true },
        },
      },
    });

    if (!vendor || vendor.status !== 'approved') throw new Error('Vendor not found');

    await setCache(cacheKey, vendor, 600);
    return vendor;
  }

  // ── Admin ─────────────────────────────────────────────────────────────────────

  async getPendingVendors() {
    return db.query.vendors.findMany({
      where: eq(vendors.status, 'pending'),
      with: {
        user:      { columns: { email: true, phone: true, verified: true } },
        documents: true,
      },
      orderBy: (vendors, { desc }) => [desc(vendors.createdAt)],
    });
  }

  async getVendorById(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
      with: {
        user:      { columns: { email: true, phone: true, verified: true } },
        documents: true,
      },
    });
    if (!vendor) throw new Error('Vendor not found');
    return vendor;
  }

  async getAllVendors(filters?: VendorFilters) {
    const conditions: any[] = [];
    if (filters?.status) conditions.push(eq(vendors.status, filters.status));

    return db.query.vendors.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        user: { columns: { email: true, phone: true } },
      },
      limit:   filters?.limit  ?? 50,
      offset:  filters?.offset ?? 0,
      orderBy: (vendors, { desc }) => [desc(vendors.createdAt)],
    });
  }

  async reviewVendorApplication(vendorId: string, adminId: string, data: VendorReviewInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor)                      throw new Error('Vendor not found');
    if (vendor.status !== 'pending')  throw new Error('Application has already been reviewed');

    const [updated] = await db.update(vendors)
      .set({
        status:          data.status,
        rejectionReason: data.rejectionReason,
        approvedBy:      data.status === 'approved' ? adminId : null,
        approvedAt:      data.status === 'approved' ? new Date() : null,
        updatedAt:       new Date(),
      })
      .where(eq(vendors.id, vendorId))
      .returning();

    await this.invalidateCache(vendor.userId, vendorId);

    // TODO: Send approval/rejection email to vendor
    return updated;
  }

  async suspendVendor(vendorId: string, reason: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw new Error('Vendor not found');

    const [updated] = await db.update(vendors)
      .set({ status: 'suspended', rejectionReason: reason, updatedAt: new Date() })
      .where(eq(vendors.id, vendorId))
      .returning();

    await this.invalidateCache(vendor.userId, vendorId);

    // TODO: Send suspension email
    // TODO: Unpublish all vendor listings
    return updated;
  }
}