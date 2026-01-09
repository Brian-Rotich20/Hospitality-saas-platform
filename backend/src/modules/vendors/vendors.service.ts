import { eq, and } from 'drizzle-orm';
import { db } from '../../config/database';
import { vendors, vendorDocuments, users } from '../../db/schema';
import { redis, setCache, getCache, delCache } from '../../config/redis';
import type { 
  VendorApplicationInput, 
  PayoutDetailsInput, 
  UpdateVendorInput,
  VendorReviewInput 
} from './vendors.schema';

export class VendorService {
  // Apply as vendor
  async applyAsVendor(userId: string, data: VendorApplicationInput) {
    // Check if user already has a vendor profile
    const existingVendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });

    if (existingVendor) {
      throw new Error('User already has a vendor application');
    }

    // Update user role to vendor
    await db.update(users)
      .set({ role: 'vendor' })
      .where(eq(users.id, userId));

    // Create vendor profile
    const [vendor] = await db.insert(vendors).values({
      userId,
      businessName: data.businessName,
      businessType: data.businessType,
      businessRegistration: data.businessRegistration,
      taxPin: data.taxPin,
      phoneNumber: data.phoneNumber,
      location: data.location,
      description: data.description,
      status: 'pending',
    }).returning();

    // TODO: Send notification to admin for review
    // TODO: Send confirmation email to vendor

    return vendor;
  }

  // Get vendor profile
  async getVendorProfile(userId: string) {
    const cacheKey = `vendor:profile:${userId}`;
    
    // Check cache first
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
      with: {
        documents: true,
        user: {
          columns: {
            email: true,
            phone: true,
            verified: true,
          },
        },
      },
    });

    if (!vendor) {
      throw new Error('Vendor profile not found');
    }

    // Cache for 10 minutes
    await setCache(cacheKey, vendor, 600);

    return vendor;
  }

  // Update vendor profile
  async updateVendorProfile(userId: string, data: UpdateVendorInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });

    if (!vendor) {
      throw new Error('Vendor profile not found');
    }

    const [updatedVendor] = await db.update(vendors)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(vendors.id, vendor.id))
      .returning();

    // Invalidate cache
    await delCache(`vendor:profile:${userId}`);

    return updatedVendor;
  }

  // Add payout details
  async addPayoutDetails(userId: string, data: PayoutDetailsInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });

    if (!vendor) {
      throw new Error('Vendor profile not found');
    }

    const updateData: any = {
      payoutMethod: data.payoutMethod,
      updatedAt: new Date(),
    };

    if (data.payoutMethod === 'mpesa') {
      updateData.mpesaNumber = data.mpesaNumber;
    } else if (data.payoutMethod === 'bank') {
      updateData.bankAccountName = data.bankAccountName;
      updateData.bankAccountNumber = data.bankAccountNumber;
      updateData.bankName = data.bankName;
    }

    const [updatedVendor] = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, vendor.id))
      .returning();

    // Invalidate cache
    await delCache(`vendor:profile:${userId}`);

    return updatedVendor;
  }

  // Upload vendor document
  async uploadDocument(
    userId: string, 
    documentType: string, 
    documentUrl: string, 
    fileName: string,
    fileSize: string
  ) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });

    if (!vendor) {
      throw new Error('Vendor profile not found');
    }

    // Check if document type already exists
    const existingDoc = await db.query.vendorDocuments.findFirst({
      where: and(
        eq(vendorDocuments.vendorId, vendor.id),
        eq(vendorDocuments.documentType, documentType)
      ),
    });

    if (existingDoc) {
      // Update existing document
      const [updatedDoc] = await db.update(vendorDocuments)
        .set({
          documentUrl,
          fileName,
          fileSize,
          uploadedAt: new Date(),
        })
        .where(eq(vendorDocuments.id, existingDoc.id))
        .returning();

      return updatedDoc;
    }

    // Create new document
    const [document] = await db.insert(vendorDocuments).values({
      vendorId: vendor.id,
      documentType,
      documentUrl,
      fileName,
      fileSize,
    }).returning();

    // Invalidate cache
    await delCache(`vendor:profile:${userId}`);

    return document;
  }

  // Get vendor documents
  async getVendorDocuments(userId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });

    if (!vendor) {
      throw new Error('Vendor profile not found');
    }

    const documents = await db.query.vendorDocuments.findMany({
      where: eq(vendorDocuments.vendorId, vendor.id),
    });

    return documents;
  }

  // Admin: Get all pending vendors
  async getPendingVendors() {
    const pendingVendors = await db.query.vendors.findMany({
      where: eq(vendors.status, 'pending'),
      with: {
        user: {
          columns: {
            email: true,
            phone: true,
            verified: true,
          },
        },
        documents: true,
      },
      orderBy: (vendors, { desc }) => [desc(vendors.createdAt)],
    });

    return pendingVendors;
  }

  // Admin: Get vendor by ID
  async getVendorById(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
      with: {
        user: {
          columns: {
            email: true,
            phone: true,
            verified: true,
          },
        },
        documents: true,
      },
    });

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    return vendor;
  }

  // Admin: Review vendor application
  async reviewVendorApplication(vendorId: string, adminId: string, data: VendorReviewInput) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    if (vendor.status !== 'pending') {
      throw new Error('Vendor application has already been reviewed');
    }

    const [updatedVendor] = await db.update(vendors)
      .set({
        status: data.status,
        rejectionReason: data.rejectionReason,
        approvedBy: data.status === 'approved' ? adminId : null,
        approvedAt: data.status === 'approved' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(vendors.id, vendorId))
      .returning();

    // Invalidate cache
    await delCache(`vendor:profile:${vendor.userId}`);

    // TODO: Send notification email to vendor
    // TODO: If approved, send welcome email with next steps
    // TODO: If rejected, send rejection email with reason

    return updatedVendor;
  }

  // Admin: Get all vendors with filters
  async getAllVendors(filters?: { status?: string; businessType?: string; limit?: number; offset?: number }) {
    const conditions = [];

    if (filters?.status) {
      conditions.push(eq(vendors.status, filters.status as any));
    }

    if (filters?.businessType) {
      conditions.push(eq(vendors.businessType, filters.businessType as any));
    }

    const allVendors = await db.query.vendors.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        user: {
          columns: {
            email: true,
            phone: true,
          },
        },
      },
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
      orderBy: (vendors, { desc }) => [desc(vendors.createdAt)],
    });

    return allVendors;
  }

  // Admin: Suspend vendor
  async suspendVendor(vendorId: string, reason: string) {
    const [vendor] = await db.update(vendors)
      .set({
        status: 'suspended',
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(vendors.id, vendorId))
      .returning();

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    // Invalidate cache
    const vendorProfile = await db.query.vendors.findFirst({
      where: eq(vendors.id, vendorId),
    });
    
    if (vendorProfile) {
      await delCache(`vendor:profile:${vendorProfile.userId}`);
    }

    // TODO: Send suspension email to vendor
    // TODO: Unpublish all vendor listings

    return vendor;
  }
}