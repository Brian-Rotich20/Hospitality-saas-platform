import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, gte, lt, sql } from 'drizzle-orm';
import { guards, requireUser, requireVendorCtx } from '../../app/policies.js';
import { ok, pagination, idParams, idempotencyHeaders } from '../../app/http.js';
import { subscriptionsService } from './service.js';
import { paymentsService, paymentCapabilities } from '../payments/service.js';
import { db } from '../../platform/database/client.js';
import { revenueEntries } from '../../platform/database/schema/subscriptions.js';

const statusFilter = z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired']).optional();

const payBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('paystack') }),
  z.object({ provider: z.literal('mpesa'), phone: z.string().min(9).max(16) }),
]);

/** Vendor-facing subscription API (mounted at /api/subscriptions). */
export const subscriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/payment-methods', { schema: { tags: ['Subscriptions'] } }, async () => ok(paymentCapabilities()));

  // Billing is reachable by every vendor, including restricted ones: they must be able to pay.
  app.get('/me', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'] } },
    async (request) => ok(await subscriptionsService.getOverview(requireVendorCtx(request).vendor.id)));

  app.get('/me/invoices', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'], querystring: pagination } },
    async (request) => ok(await subscriptionsService.listInvoices(requireVendorCtx(request).vendor.id, request.query.limit, request.query.offset)));

  app.get('/me/payments', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'], querystring: pagination } },
    async (request) => ok(await subscriptionsService.listPayments(requireVendorCtx(request).vendor.id, request.query.limit, request.query.offset)));

  app.post('/me/payments', {
    preValidation: guards.vendor,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['Subscriptions'], body: payBody, headers: idempotencyHeaders },
  }, async (request, reply) => {
    const attempt = await paymentsService.initiate({
      vendorId: requireVendorCtx(request).vendor.id,
      userId: requireUser(request).userId,
      provider: request.body.provider === 'mpesa' ? 'daraja' : 'paystack',
      phone: request.body.provider === 'mpesa' ? request.body.phone : undefined,
      idempotencyKey: request.headers['idempotency-key'],
    });
    reply.code(202);
    return ok(presentAttempt(attempt));
  });

  app.get('/me/payments/:id', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'], params: idParams } },
    async (request) => ok(presentAttempt(await paymentsService.getForVendor(requireVendorCtx(request).vendor.id, request.params.id))));

  app.post('/me/cancel', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'] } },
    async (request) => ok(await subscriptionsService.cancel(requireVendorCtx(request).vendor.id, requireUser(request).userId, request.id)));

  app.post('/me/resume', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'] } },
    async (request) => ok(await subscriptionsService.resume(requireVendorCtx(request).vendor.id, requireUser(request).userId, request.id)));

  app.patch('/me/auto-renew', { preValidation: guards.vendor, schema: { tags: ['Subscriptions'], body: z.object({ enabled: z.boolean() }) } },
    async (request) => {
      const sub = await subscriptionsService.setAutoRenew(requireVendorCtx(request).vendor.id, request.body.enabled, requireUser(request).userId, paymentCapabilities().paystackRecurring);
      return ok({ autoRenewOptIn: sub.autoRenewOptIn });
    });
};

/** Admin subscription controls (mounted at /api/admin/subscriptions). */
export const subscriptionAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);

  app.get('/', { schema: { tags: ['Admin - Subscriptions'], querystring: pagination.extend({ status: statusFilter }) } },
    async (request) => ok(await subscriptionsService.listForAdmin(request.query)));

  app.get('/plans', { schema: { tags: ['Admin - Subscriptions'] } }, async () => ok(await subscriptionsService.listPlans()));

  app.get('/vendors/:vendorId', { schema: { tags: ['Admin - Subscriptions'], params: z.object({ vendorId: z.string().uuid() }) } },
    async (request) => ok(await subscriptionsService.getForAdmin(request.params.vendorId)));

  app.post('/plans', {
    schema: {
      tags: ['Admin - Subscriptions'],
      body: z.object({
        code: z.string().min(2).max(50).regex(/^[a-z0-9_-]+$/),
        name: z.string().min(2).max(100),
        amountMinor: z.number().int().positive().max(100_000_000),
        currency: z.literal('KES'),
        activate: z.boolean().default(false),
      }),
    },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await subscriptionsService.createPlan(request.body, requireUser(request).userId, request.id));
  });

  app.patch('/plans/:id', { schema: { tags: ['Admin - Subscriptions'], params: idParams, body: z.object({ active: z.boolean() }) } },
    async (request) => ok(await subscriptionsService.setPlanActive(request.params.id, request.body.active, requireUser(request).userId, request.id)));

  // Vendors that predate subscriptions. Enrolment is a deliberate, per-vendor admin action
  // pending an approved transition policy (see docs/refactor/IMPLEMENTATION-REPORT.md).
  app.get('/unenrolled', { schema: { tags: ['Admin - Subscriptions'] } }, async () => ok(await subscriptionsService.listUnenrolledVendors()));

  app.post('/unenrolled/:vendorId/enrol', { schema: { tags: ['Admin - Subscriptions'], params: z.object({ vendorId: z.string().uuid() }) } },
    async (request, reply) => {
      reply.code(201);
      return ok(await subscriptionsService.enrolLegacyVendor(request.params.vendorId, requireUser(request).userId, request.id));
    });

  /** Revenue summary computed from the append-only journal, never from payment statuses. */
  app.get('/revenue', {
    schema: { tags: ['Admin - Subscriptions'], querystring: z.object({ from: z.coerce.date(), to: z.coerce.date() }) },
  }, async (request) => {
    const rows = await db.select({
      currency: revenueEntries.currency,
      entryType: revenueEntries.entryType,
      totalMinor: sql<string>`sum(${revenueEntries.amountMinor})`,
      count: sql<number>`count(*)::int`,
      needsReview: sql<number>`count(*) filter (where ${revenueEntries.requiresReview})::int`,
    }).from(revenueEntries)
      .where(and(gte(revenueEntries.occurredAt, request.query.from), lt(revenueEntries.occurredAt, request.query.to)))
      .groupBy(revenueEntries.currency, revenueEntries.entryType);
    return ok(rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) })));
  });

};

function presentAttempt(a: { id: string; provider: string; status: string; amountMinor: number; currency: string; checkoutUrl: string | null; providerReference: string | null; providerReceipt: string | null; phoneMasked: string | null; failureReason: string | null; createdAt: Date; completedAt: Date | null; providerMetadata: Record<string, unknown> | null } | undefined) {
  if (!a) return null;
  return {
    id: a.id,
    provider: a.provider === 'daraja' ? 'mpesa' : a.provider,
    status: a.status,
    amountMinor: a.amountMinor,
    currency: a.currency,
    checkoutUrl: a.status === 'pending' ? a.checkoutUrl : null,
    reference: a.providerReference,
    receipt: a.providerReceipt,
    phone: a.phoneMasked,
    failureReason: a.failureReason,
    message: typeof a.providerMetadata?.customerMessage === 'string' ? a.providerMetadata.customerMessage : null,
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}
