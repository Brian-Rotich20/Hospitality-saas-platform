import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser, requireVendorCtx } from '../../app/policies.js';
import { ok, pagination } from '../../app/http.js';
import { vendorsService, ownerView, profileCompleteness } from './service.js';
import { vendorsRepo } from './repo.js';
import { ForbiddenError } from '../../app/errors.js';
import { contactEmail, contactPhone } from './contact.js';

export const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');

// Business profile. Contact numbers accept Kenyan local or international formats and are
// stored as E.164 (+2547…); null or "" clears a contact field. Unknown fields are ignored.
const profileBody = z.object({
  businessName: z.string().trim().min(3).max(255).optional(),
  logo: z.string().url().max(500).optional(),
  businessEmail: contactEmail.optional(),
  phoneNumber: contactPhone.optional(),
  whatsappNumber: contactPhone.optional(),
});

const payoutBody = z.discriminatedUnion('payoutMethod', [
  z.object({ payoutMethod: z.literal('mpesa'), mpesaNumber: kenyanPhone }),
  z.object({ payoutMethod: z.literal('bank'), bankAccountName: z.string().min(3).max(255), bankAccountNumber: z.string().min(5).max(50), bankName: z.string().min(2).max(100) }),
]);

const vendorIdParams = z.object({ vendorId: z.string().uuid() });

/** Mounted at /api/vendors. */
export const vendorRoutes: FastifyPluginAsyncZod = async (app) => {
  // Instant self-service onboarding. Customers only (admins cannot become vendors);
  // calling it again as a vendor returns the existing profile.
  app.post('/become', {
    preValidation: guards.verifiedUser,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    // The body is optional: a missing or empty body onboards with defaults from the user profile.
    schema: { tags: ['Vendors'], body: z.preprocess((v) => v ?? {}, z.object({ businessName: z.string().trim().min(3).max(255).optional(), phoneNumber: contactPhone.optional() })) },
  }, async (request, reply) => {
    const authCtx = requireUser(request);
    if (authCtx.role === 'admin') throw new ForbiddenError('Administrator accounts cannot become vendors', 'ADMIN_CANNOT_ONBOARD');
    const { vendor, created } = await vendorsService.onboard(authCtx.userId, request.body, request.id);
    reply.code(created ? 201 : 200);
    return ok(ownerView(vendor), { message: created ? 'Your vendor account is ready. Your one-month free trial has started.' : 'You are already a vendor' });
  });

  app.get('/me', { preValidation: guards.vendor, schema: { tags: ['Vendors'] } }, async (request) => {
    const { vendor, entitlement } = requireVendorCtx(request);
    const { complete, missing, contactMissing } = profileCompleteness(vendor);
    return ok({ ...ownerView(vendor), profileComplete: complete, missing, contactMissing, subscription: entitlement });
  });

  app.put('/me', { preValidation: guards.vendor, schema: { tags: ['Vendors'], body: profileBody } },
    async (request) => ok(ownerView(await vendorsService.updateProfile(requireVendorCtx(request).vendor, request.body)), { message: 'Profile updated' }));

  // Private to the vendor. Never exposed publicly or to customers.
  app.post('/me/payout-details', { preValidation: guards.vendor, schema: { tags: ['Vendors'], body: payoutBody } },
    async (request) => ok(ownerView(await vendorsService.setPayoutDetails(requireVendorCtx(request).vendor, request.body)), { message: 'Payout details saved' }));

  app.get('/:vendorId', { schema: { tags: ['Vendors'], params: vendorIdParams } },
    async (request) => ok(await vendorsService.getPublic(request.params.vendorId)));
};

/** Mounted at /api/admin/vendors. */
export const vendorAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);

  app.get('/', { schema: { tags: ['Admin - Vendors'], querystring: pagination.extend({ status: z.enum(['approved', 'suspended']).optional() }) } },
    async (request) => {
      const rows = await vendorsRepo.listForAdmin(request.query);
      return ok(rows.map(({ userEmail, userFullName, userPhone, ...r }) => ({ ...r, user: { email: userEmail, fullName: userFullName, phone: userPhone } })));
    });

  app.get('/:vendorId', { schema: { tags: ['Admin - Vendors'], params: vendorIdParams } },
    async (request) => ok(await vendorsService.getForAdmin(request.params.vendorId)));

  app.put('/:vendorId/suspend', { schema: { tags: ['Admin - Vendors'], params: vendorIdParams, body: z.preprocess((v) => v ?? {}, z.object({ reason: z.string().min(5).max(500).optional() })) } },
    async (request) => ok(await vendorsService.setStatus(request.params.vendorId, 'suspended', requireUser(request).userId, request.body.reason, request.id), { message: 'Vendor suspended' }));

  app.put('/:vendorId/reinstate', { schema: { tags: ['Admin - Vendors'], params: vendorIdParams, body: z.preprocess((v) => v ?? {}, z.object({ reason: z.string().max(500).optional() })) } },
    async (request) => ok(await vendorsService.setStatus(request.params.vendorId, 'approved', requireUser(request).userId, request.body.reason, request.id), { message: 'Vendor reinstated' }));
};
