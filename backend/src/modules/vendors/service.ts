// Vendor lifecycle. Two independent dimensions:
//   vendor status (admin moderation): approved | suspended
//   subscription status (billing): see modules/subscriptions
// Onboarding is instant and self-service: no admin approval step.
import { eq } from 'drizzle-orm';
import { withTransaction } from '../../platform/database/client.js';
import { users } from '../../platform/database/schema/users.js';
import { cache } from '../../platform/cache/redis.js';
import { vendorsRepo, publicVendorColumns, type VendorRow } from './repo.js';
import { subscriptionsService } from '../subscriptions/service.js';
import { recordAudit } from '../../app/audit.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../app/errors.js';
import { missingContact } from './contact.js';

const publicKey = (vendorId: string) => `vendor:public:v4:${vendorId}`;

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'vendor';
  return `${base}-${Date.now().toString(36)}`;
}

const CONTACT_LABEL = { businessEmail: 'business email', phoneNumber: 'phone number', whatsappNumber: 'WhatsApp number' } as const;

/**
 * What the profile still lacks, as human labels (`missing`). `contactMissing` lists the
 * contact fields (API names) that must be filled in before a listing can be published.
 */
export function profileCompleteness(v: Pick<VendorRow, 'logo' | 'phoneNumber' | 'businessEmail' | 'whatsappNumber'>) {
  const contactMissing = missingContact(v);
  const missing: string[] = contactMissing.map((k) => CONTACT_LABEL[k]);
  if (!v.logo) missing.push('logo');
  return { complete: missing.length === 0, missing, contactMissing };
}

/** The owner's view: includes payout details, never shown to anyone else. */
export function ownerView(v: VendorRow) {
  return {
    id: v.id, businessName: v.businessName, slug: v.slug, logo: v.logo, verified: v.verified,
    businessEmail: v.businessEmail, phoneNumber: v.phoneNumber, whatsappNumber: v.whatsappNumber,
    status: v.status, onboardedAt: v.onboardedAt, createdAt: v.createdAt, updatedAt: v.updatedAt,
    payoutDetails: { method: v.payoutMethod, mpesaNumber: v.mpesaNumber, bankAccountName: v.bankAccountName, bankAccountNumber: v.bankAccountNumber, bankName: v.bankName },
  };
}

export const vendorsService = {
  /**
   * Become a vendor: creates the vendor profile, switches the account to the vendor role
   * and starts the one-month free trial, atomically. Idempotent for existing vendors.
   */
  async onboard(userId: string, input: { businessName?: string | undefined; phoneNumber?: string | null | undefined }, requestId?: string) {
    return withTransaction(async (tx) => {
      const [user] = await tx.select({ id: users.id, role: users.role, fullName: users.fullName, phone: users.phone })
        .from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new NotFoundError('User');
      const existing = await vendorsRepo.findByUserId(userId, tx);
      if (existing) return { vendor: existing, created: false };
      if (user.role === 'admin') throw new ForbiddenError('Administrator accounts cannot become vendors', 'ADMIN_CANNOT_ONBOARD');

      const businessName = input.businessName ?? user.fullName ?? 'My Business';
      const now = new Date();
      const vendor = await vendorsRepo.insert({
        userId, businessName, slug: slugify(businessName), phoneNumber: input.phoneNumber ?? user.phone,
        status: 'approved', verified: false, onboardedAt: now,
      }, tx);
      await tx.update(users).set({ role: 'vendor', vendorId: vendor.id, updatedAt: now }).where(eq(users.id, userId));
      const subscription = await subscriptionsService.startTrial(vendor.id, tx, { now, origin: 'onboarding' });
      await recordAudit({ actorUserId: userId, actorType: 'user', action: 'vendor.onboarded', entityType: 'vendor', entityId: vendor.id, details: { trialEndsAt: subscription.trialEndsAt.toISOString() }, requestId }, tx);
      return { vendor, created: true };
    });
  },

  /**
   * Update the vendor's own business profile (identity and public contact). The vendor is
   * always the caller's own (from the session); the login email on the user is never touched.
   * Contact numbers arrive already normalised by the route schema; null clears a field.
   */
  async updateProfile(vendor: VendorRow, input: {
    businessName?: string | undefined; logo?: string | undefined;
    businessEmail?: string | null | undefined; phoneNumber?: string | null | undefined; whatsappNumber?: string | null | undefined;
  }) {
    // Slugs are stable: renaming a business must not break shared links.
    const updated = await vendorsRepo.update(vendor.id, {
      ...(input.businessName !== undefined && { businessName: input.businessName }),
      ...(input.logo !== undefined && { logo: input.logo }),
      ...(input.businessEmail !== undefined && { businessEmail: input.businessEmail }),
      ...(input.phoneNumber !== undefined && { phoneNumber: input.phoneNumber }),
      ...(input.whatsappNumber !== undefined && { whatsappNumber: input.whatsappNumber }),
    });
    await cache.del(publicKey(vendor.id));
    await cache.bump('catalog');
    if (!updated) throw new NotFoundError('Vendor');
    return updated;
  },

  async setPayoutDetails(vendor: VendorRow, input: { payoutMethod: 'mpesa'; mpesaNumber: string } | { payoutMethod: 'bank'; bankAccountName: string; bankAccountNumber: string; bankName: string }) {
    const values = input.payoutMethod === 'mpesa'
      ? { payoutMethod: 'mpesa', mpesaNumber: input.mpesaNumber }
      : { payoutMethod: 'bank', bankAccountName: input.bankAccountName, bankAccountNumber: input.bankAccountNumber, bankName: input.bankName };
    const updated = await vendorsRepo.update(vendor.id, values);
    if (!updated) throw new NotFoundError('Vendor');
    return updated;
  },

  /** Public profile: only approved vendors whose subscription entitles them to be shown. */
  async getPublic(vendorId: string) {
    const cached = await cache.get<Record<string, unknown>>(publicKey(vendorId));
    if (cached) return cached;
    const v = await vendorsRepo.findPublic(vendorId);
    if (!v) throw new NotFoundError('Vendor');
    if (!(await subscriptionsService.getEntitlement(vendorId)).entitled) throw new NotFoundError('Vendor');
    const out = Object.fromEntries(Object.keys(publicVendorColumns).map((k) => [k, v[k as keyof typeof v]]));
    await cache.set(publicKey(vendorId), out, 600);
    return out;
  },

  // ── Admin moderation (independent of subscription status) ────────────────
  async setStatus(vendorId: string, status: 'approved' | 'suspended', adminUserId: string, reason: string | undefined, requestId?: string) {
    const updated = await withTransaction(async (tx) => {
      const v = await vendorsRepo.lock(vendorId, tx);
      if (!v) throw new NotFoundError('Vendor');
      if (v.status === status) throw new ConflictError(`Vendor is already ${status}`, 'NO_CHANGE');
      const row = await vendorsRepo.update(vendorId, { status }, tx);
      // The account keeps the vendor role: a suspended vendor must not be able to book as a customer.
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: status === 'suspended' ? 'vendor.suspended' : 'vendor.reinstated', entityType: 'vendor', entityId: vendorId, details: { reason: reason ?? null }, requestId }, tx);
      return row;
    });
    await cache.del(publicKey(vendorId));
    await cache.bump('catalog');
    return updated;
  },

  async getForAdmin(vendorId: string) {
    const v = await vendorsRepo.findById(vendorId);
    if (!v) throw new NotFoundError('Vendor');
    const entitlement = await subscriptionsService.getEntitlement(vendorId);
    // Payout details are private to the vendor; LinkMart makes no payouts, so administrators
    // only need to know whether any are on file (decision D9 pending).
    const { payoutDetails, ...view } = ownerView(v);
    return { ...view, hasPayoutDetails: payoutDetails.method != null, userId: v.userId, subscription: entitlement };
  },
};
