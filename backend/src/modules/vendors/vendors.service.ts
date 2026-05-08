// src/modules/vendors/vendors.service.ts
import { eq, and, desc } from 'drizzle-orm';
import { db }            from '../../config/database';
import { vendors, vendorDocuments } from '../../db/schema/vendors';
import { users }                    from '../../db/schema/users';
import { setCache, getCache, delCache } from '../../config/redis';
import { UploadResult }  from '../upload/upload.types';
import {
  sendVendorVerificationEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
} from '../../utils/email';
import { redis } from '../../config/redis';
import type {
  VendorApplicationInput, PayoutDetailsInput,
  UpdateVendorInput,      VendorReviewInput,
} from './vendors.schema';
import type { VendorFilters } from './vendors.types';

// OTP TTL — 15 minutes
const OTP_TTL = 15 * 60;

function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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

  // ── Apply as vendor — creates account + sends OTP ────────────────────────

  async applyAsVendor(userId: string, data: VendorApplicationInput) {
    const existing = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (existing) {
      // If pending_verification, allow resend OTP
      if (existing.status === 'pending_verification') {
        await this._sendOTP(userId, existing.id, data.businessName);
        return { vendor: existing, otpSent: true };
      }
      throw new Error('You already have a vendor application');
    }

    // Get user email for OTP
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true },
    });
    if (!user) throw new Error('User not found');

    const slug = this.generateSlug(data.businessName);

    const [vendor] = await db.insert(vendors).values({
      userId,
      businessName:   data.businessName,
      slug,
      description:    data.description,
      phoneNumber:    data.phoneNumber,
      whatsappNumber: data.whatsappNumber,
      website:        data.website,
      status:         'pending_verification', // ← new status
      verified:       false,
    }).returning();

    // Send OTP email
    await this._sendOTP(userId, vendor.id, data.businessName, user.email);

    return { vendor, otpSent: true };
  }

  // ── Send OTP (internal) ───────────────────────────────────────────────────

  private async _sendOTP(userId: string, vendorId: string, businessName: string | undefined, email?: string) {
    // Get email if not passed
    if (!email) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true },
      });
      email = user?.email;
    }
    if (!email) throw new Error('User email not found');

    const otp = generateOTP();
    const key = `vendor:otp:${userId}`;

    // Store OTP in Redis with TTL
    await redis.setex(key, OTP_TTL, JSON.stringify({ otp, vendorId, attempts: 0 }));

    // Send email
    await sendVendorVerificationEmail({
      to:           email,
      businessName,
      otp,
    });

    return { sent: true };
  }

  // ── Verify OTP — activates vendor account ────────────────────────────────

  async verifyVendorOTP(userId: string, otp: string) {
    const key     = `vendor:otp:${userId}`;
    const stored  = await redis.get(key) as string | null;

    if (!stored) {
      throw new Error('OTP expired or not found. Please request a new one.');
    }

    const data = JSON.parse(stored) as { otp: string; vendorId: string; attempts: number };

    // Max 5 attempts
    if (data.attempts >= 5) {
      await redis.del(key);
      throw new Error('Too many attempts. Please request a new OTP.');
    }

    if (data.otp !== otp) {
      // Increment attempts
      data.attempts += 1;
      await redis.setex(key, OTP_TTL, JSON.stringify(data));
      const remaining = 5 - data.attempts;
      throw new Error(`Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
    }

    // ✅ OTP correct — activate vendor
    await redis.del(key);

    // Update vendor status to approved
    const [vendor] = await db.update(vendors)
      .set({
        status:    'approved',
        verified:  true,
        updatedAt: new Date(),
      })
      .where(eq(vendors.id, data.vendorId))
      .returning();

    // Upgrade user role to vendor
    await db.update(users)
      .set({ role: 'vendor', updatedAt: new Date() })
      .where(eq(users.id, userId));

    await this.invalidateCache(userId, data.vendorId);

    // Send welcome email
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });
    if (user?.email) {
      await sendVendorApprovedEmail({
        to:           user.email,
        businessName: vendor.businessName,
      }).catch(() => {}); // non-blocking
    }

    return vendor;
  }

  // ── Resend OTP ────────────────────────────────────────────────────────────

  async resendOTP(userId: string) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
    });
    if (!vendor) throw new Error('No vendor application found');
    if (vendor.status !== 'pending_verification') {
      throw new Error('Account is already verified');
    }

    // Rate limit — check if OTP was sent in last 60 seconds
    const key    = `vendor:otp:${userId}`;
    const stored = await redis.get(key) as string | null;
    if (stored) {
      const ttl = await redis.ttl(key);
      if (ttl > OTP_TTL - 60) {
        throw new Error('Please wait 60 seconds before requesting a new code.');
      }
    }

    await this._sendOTP(userId, vendor.id, vendor.businessName);
    return { sent: true };
  }

  // ── Check if profile is complete enough to publish listings ──────────────

  isProfileComplete(vendor: any): { complete: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!vendor.logo)        missing.push('logo');
    if (!vendor.description) missing.push('description');
    if (!vendor.phoneNumber) missing.push('phone number');
    return { complete: missing.length === 0, missing };
  }

  // ── Get vendor profile ────────────────────────────────────────────────────

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
        id: vendors.id, userId: vendors.userId,
        businessName: vendors.businessName, description: vendors.description,
        phoneNumber: vendors.phoneNumber, city: vendors.city,
        status: vendors.status, verified: vendors.verified,
        createdAt: vendors.createdAt,
        userEmail: users.email, userPhone: users.phone, userFullName: users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(eq(vendors.status, 'pending'))
      .orderBy(desc(vendors.createdAt));

    return rows.map(r => ({
      ...r,
      user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName },
    }));
  }

  async getAllVendors(filters?: VendorFilters) {
    const conditions: any[] = [];
    if (filters?.status) conditions.push(eq(vendors.status, filters.status as any));

    const rows = await db
      .select({
        id: vendors.id, userId: vendors.userId,
        businessName: vendors.businessName, description: vendors.description,
        phoneNumber: vendors.phoneNumber, city: vendors.city,
        status: vendors.status, verified: vendors.verified,
        createdAt: vendors.createdAt,
        userEmail: users.email, userPhone: users.phone, userFullName: users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(filters?.limit ?? 50)
      .offset(filters?.offset ?? 0)
      .orderBy(desc(vendors.createdAt));

    return rows.map(r => ({
      ...r,
      user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName },
    }));
  }

  async getVendorById(vendorId: string) {
    const rows = await db
      .select({
        id: vendors.id, userId: vendors.userId,
        businessName: vendors.businessName, description: vendors.description,
        phoneNumber: vendors.phoneNumber, city: vendors.city,
        status: vendors.status, verified: vendors.verified,
        rejectionReason: vendors.rejectionReason,
        createdAt: vendors.createdAt,
        userEmail: users.email, userPhone: users.phone, userFullName: users.fullName,
      })
      .from(vendors)
      .leftJoin(users, eq(users.id, vendors.userId))
      .where(eq(vendors.id, vendorId))
      .limit(1);

    if (!rows[0]) throw new Error('Vendor not found');
    const r = rows[0];
    return { ...r, user: { email: r.userEmail, phone: r.userPhone, fullName: r.userFullName } };
  }

  // ── Admin: review (still available for manual override) ───────────────────

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

    const newRole = data.status === 'approved' ? 'vendor' : 'customer';
    await db.update(users)
      .set({ role: newRole })
      .where(eq(users.id, vendor.userId));

    // Send email notification
    const user = await db.query.users.findFirst({
      where: eq(users.id, vendor.userId),
      columns: { email: true },
    });
    if (user?.email) {
      if (data.status === 'approved') {
        await sendVendorApprovedEmail({
          to: user.email, businessName: vendor.businessName,
        }).catch(() => {});
      } else {
        await sendVendorRejectedEmail({
          to: user.email, businessName: vendor.businessName,
          reason: data.rejectionReason,
        }).catch(() => {});
      }
    }

    await this.invalidateCache(vendor.userId, vendorId);
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

    await db.update(users)
      .set({ role: 'customer' })
      .where(eq(users.id, vendor.userId));

    await this.invalidateCache(vendor.userId, vendorId);
    return updated;
  }
}