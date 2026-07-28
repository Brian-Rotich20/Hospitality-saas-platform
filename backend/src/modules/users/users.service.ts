// src/modules/users/users.service.ts
import { eq, and } from 'drizzle-orm';
import { db }      from '../../config/database.js';
import { users }   from '../../db/schema/users.js';
import { savedListings } from '../../db/schema/savedListings.js';
import { listings }      from '../../db/schema/listings.js';

export class UserService {

  // ── Get profile ──────────────────────────────────────────────────────────
  async getProfile(userId: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true, email: true, fullName: true,
        phone: true, role: true, avatarUrl: true,
        verified: true, createdAt: true,
      },
    });
    if (!user) throw new Error('User not found');
    return user;
  }

  // ── Update profile ───────────────────────────────────────────────────────
  async updateProfile(userId: string, data: {
    fullName?: string | undefined;
    phone?:    string | undefined;
    avatarUrl?: string | undefined;
  }) {
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (data.fullName  != null) updateData.fullName  = data.fullName;
    if (data.phone     != null) updateData.phone     = data.phone;
    if (data.avatarUrl != null) updateData.avatarUrl = data.avatarUrl;

    const [updated] = await db.update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning({
        id: users.id, email: users.email, fullName: users.fullName,
        phone: users.phone, role: users.role, avatarUrl: users.avatarUrl,
      });

    if (!updated) throw new Error('User not found');
    return updated;
  }

  // ── Save listing (toggle) ─────────────────────────────────────────────────
  async toggleSaved(userId: string, listingId: string) {
    const existing = await db.query.savedListings.findFirst({
      where: and(
        eq(savedListings.userId,    userId),
        eq(savedListings.listingId, listingId),
      ),
    });

    if (existing) {
      await db.delete(savedListings)
        .where(eq(savedListings.id, existing.id));
      return { saved: false };
    }

    // Verify listing exists
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId),
      columns: { id: true },
    });
    if (!listing) throw new Error('Listing not found');

    await db.insert(savedListings).values({ userId, listingId });
    return { saved: true };
  }

  // ── Get saved listings ────────────────────────────────────────────────────
  async getSavedListings(userId: string) {
    const rows = await db.query.savedListings.findMany({
      where: eq(savedListings.userId, userId),
      with: {
        listing: {
          with: {
            vendor:   { columns: { businessName: true, verified: true } },
            category: { columns: { name: true, slug: true } },
          },
        },
      },
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
    return rows.map(r => r.listing).filter(Boolean);
  }

  // ── Check if listing is saved ─────────────────────────────────────────────
  async isSaved(userId: string, listingId: string) {
    const row = await db.query.savedListings.findFirst({
      where: and(
        eq(savedListings.userId,    userId),
        eq(savedListings.listingId, listingId),
      ),
    });
    return { saved: !!row };
  }

  // ── Customer stats (for dashboard) ────────────────────────────────────────
  async getCustomerStats(userId: string) {
    const { bookings } = await import('../../db/schema/bookings.js');
    const { inArray, count, eq: eqOp, and: andOp } = await import('drizzle-orm');

    const allBookings = await db.query.bookings.findMany({
      where: eq(bookings.customerId, userId),
      columns: { id: true, status: true, totalAmount: true, currency: true },
    });

    const total     = allBookings.length;
    const pending   = allBookings.filter(b => b.status === 'pending').length;
    const confirmed = allBookings.filter(b => b.status === 'confirmed').length;
    const completed = allBookings.filter(b => b.status === 'completed').length;
    const spent     = allBookings
      .filter(b => b.status === 'completed')
      .reduce((sum, b) => sum + parseFloat(b.totalAmount ?? '0'), 0);

    const savedCount = await db.query.savedListings.findMany({
      where: eq(savedListings.userId, userId),
      columns: { id: true },
    }).then(r => r.length);

    return { total, pending, confirmed, completed, spent, savedCount };
  }
}