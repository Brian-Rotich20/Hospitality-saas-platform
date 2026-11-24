// Customer–vendor messaging, scoped to a booking. A conversation opens when the vendor
// accepts. It is writable while the booking is accepted, and for a configurable window
// after completion; declined/expired/cancelled bookings make it read-only.
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import { conversations, messages, messageReports } from '../../platform/database/schema/messaging.js';
import { bookings } from '../../platform/database/schema/bookings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { env } from '../../platform/config/env.js';
import { addDays } from '../../platform/time.js';
import { enqueueOutbox } from '../notifications/outbox.js';
import { recordAudit } from '../../app/audit.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../app/errors.js';
import type { AuthContext } from '../../app/policies.js';

type BookingLike = { id: string; customerId: string };
type ConversationRow = typeof conversations.$inferSelect;

/** 15-minute window used to throttle new-message emails per recipient. */
const notifyBucket = (d: Date) => Math.floor(d.getTime() / (15 * 60_000));

async function participant(conversationId: string, actor: AuthContext): Promise<{ conv: ConversationRow; side: 'customer' | 'vendor' | 'admin' }> {
  const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!conv) throw new NotFoundError('Conversation');
  if (conv.customerId === actor.userId) return { conv, side: 'customer' };
  if (actor.role === 'vendor') {
    const v = await db.query.vendors.findFirst({ where: eq(vendors.userId, actor.userId), columns: { id: true } });
    if (v?.id === conv.vendorId) return { conv, side: 'vendor' };
  }
  if (actor.role === 'admin') return { conv, side: 'admin' };
  throw new NotFoundError('Conversation');
}

async function isWritable(conv: ConversationRow): Promise<boolean> {
  const b = await db.query.bookings.findFirst({ where: eq(bookings.id, conv.bookingId), columns: { status: true, completedAt: true } });
  if (!b) return false;
  if (b.status === 'accepted') return true;
  if (b.status === 'completed' && b.completedAt) return addDays(b.completedAt, env.MESSAGING_OPEN_DAYS_AFTER_COMPLETION) > new Date();
  return false;
}

export const messagingService = {
  /** Called inside the acceptance transaction. Idempotent per booking. */
  async openForBooking(tx: Db, booking: BookingLike, vendorId: string) {
    await tx.insert(conversations).values({ bookingId: booking.id, customerId: booking.customerId, vendorId })
      .onConflictDoNothing({ target: conversations.bookingId });
  },

  async listMine(actor: AuthContext) {
    const vendor = actor.role === 'vendor' ? await db.query.vendors.findFirst({ where: eq(vendors.userId, actor.userId), columns: { id: true } }) : undefined;
    const where = vendor ? eq(conversations.vendorId, vendor.id) : eq(conversations.customerId, actor.userId);
    return db.select({
      id: conversations.id, bookingId: conversations.bookingId, lastMessageAt: conversations.lastMessageAt, createdAt: conversations.createdAt,
      bookingStatus: bookings.status, listingTitle: listings.title, listingId: listings.id, businessName: vendors.businessName,
    }).from(conversations)
      .innerJoin(bookings, eq(bookings.id, conversations.bookingId))
      .innerJoin(listings, eq(listings.id, bookings.listingId))
      .innerJoin(vendors, eq(vendors.id, conversations.vendorId))
      .where(where)
      .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.createdAt))
      .limit(100);
  },

  async byBooking(bookingId: string, actor: AuthContext) {
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.bookingId, bookingId), columns: { id: true } });
    if (!conv) throw new NotFoundError('Conversation');
    const { conv: c } = await participant(conv.id, actor);
    return { ...c, writable: await isWritable(c) };
  },

  async listMessages(conversationId: string, actor: AuthContext, opts: { after?: Date | undefined; limit: number }) {
    const { conv, side } = await participant(conversationId, actor);
    const rows = await db.select().from(messages)
      .where(and(eq(messages.conversationId, conversationId), opts.after ? gt(messages.createdAt, opts.after) : undefined))
      .orderBy(asc(messages.createdAt)).limit(opts.limit);
    return {
      conversationId: conv.id,
      writable: side !== 'admin' && (await isWritable(conv)),
      messages: rows.map((m) => ({
        id: m.id,
        mine: m.senderUserId === actor.userId,
        senderRole: m.senderUserId === conv.customerId ? 'customer' : 'vendor',
        // Hidden messages remain stored for moderation but their text is withheld from parties.
        body: m.hiddenAt && side !== 'admin' ? null : m.body,
        hidden: m.hiddenAt !== null,
        createdAt: m.createdAt,
      })),
    };
  },

  async send(conversationId: string, actor: AuthContext, body: string) {
    const { conv, side } = await participant(conversationId, actor);
    if (side === 'admin') throw new ForbiddenError('Administrators cannot post in customer conversations');
    if (!(await isWritable(conv))) throw new ConflictError('This conversation is closed', 'CONVERSATION_CLOSED');
    return withTransaction(async (tx) => {
      const now = new Date();
      const [msg] = await tx.insert(messages).values({ conversationId, senderUserId: actor.userId, body }).returning();
      await tx.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversationId));
      const recipient = side === 'customer' ? 'vendor' : 'customer';
      await enqueueOutbox(tx, 'message.created', { conversationId, recipient },
        { dedupeKey: `message:${conversationId}:${recipient}:${notifyBucket(now)}`, availableAt: new Date(now.getTime() + 60_000) });
      if (!msg) throw new Error('message insert returned no row');
      return { id: msg.id, body: msg.body, createdAt: msg.createdAt, mine: true };
    });
  },

  async report(messageId: string, actor: AuthContext, reason: string) {
    const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!msg) throw new NotFoundError('Message');
    const { side } = await participant(msg.conversationId, actor);
    if (side === 'admin') throw new ForbiddenError('Use moderation tools instead');
    if (msg.senderUserId === actor.userId) throw new ConflictError('You cannot report your own message', 'OWN_MESSAGE');
    const [row] = await db.insert(messageReports).values({ messageId, reporterId: actor.userId, reason }).onConflictDoNothing().returning();
    return row ?? { duplicate: true };
  },

  // ── Moderation (admin) ─────────────────────────────────────────────────────
  listOpenReports() {
    return db.select({ report: messageReports, message: { id: messages.id, body: messages.body, conversationId: messages.conversationId, hiddenAt: messages.hiddenAt, senderUserId: messages.senderUserId } })
      .from(messageReports).innerJoin(messages, eq(messages.id, messageReports.messageId))
      .where(isNull(messageReports.resolvedAt)).orderBy(asc(messageReports.createdAt)).limit(200);
  },

  async moderate(messageId: string, adminUserId: string, action: 'hide' | 'dismiss', requestId?: string) {
    return withTransaction(async (tx) => {
      const msg = await tx.query.messages.findFirst({ where: eq(messages.id, messageId) });
      if (!msg) throw new NotFoundError('Message');
      const now = new Date();
      if (action === 'hide' && !msg.hiddenAt) await tx.update(messages).set({ hiddenAt: now, hiddenBy: adminUserId }).where(eq(messages.id, messageId));
      await tx.update(messageReports).set({ resolvedAt: now, resolvedBy: adminUserId, resolution: action })
        .where(and(eq(messageReports.messageId, messageId), isNull(messageReports.resolvedAt)));
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: `message.${action}`, entityType: 'message', entityId: messageId, requestId }, tx);
      return { messageId, action };
    });
  },
};
