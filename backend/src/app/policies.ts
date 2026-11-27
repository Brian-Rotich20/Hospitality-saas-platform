// Central authorization. Routes compose these guards (as `preValidation` hooks, so an
// unauthenticated caller gets 401 before any body validation); services re-check the
// business rules that matter (ownership, state) so a missing guard can't open a hole.
import type { FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../modules/identity/auth.js';
import { vendorsRepo, type VendorRow } from '../modules/vendors/repo.js';
import { subscriptionsService, type Entitlement } from '../modules/subscriptions/service.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

export type Role = 'customer' | 'vendor' | 'admin';

export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  emailVerified: boolean;
}

export interface VendorContext {
  vendor: VendorRow;
  entitlement: Entitlement;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    vendorCtx: VendorContext | null;
  }
}

function isRole(v: unknown): v is Role {
  return v === 'customer' || v === 'vendor' || v === 'admin';
}

/** Resolve the Better Auth session, or null. Never throws for a bad/expired cookie. */
export async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  } catch {
    return null;
  }
  if (!session?.user) return null;
  const u = session.user as typeof session.user & { role?: unknown; banned?: boolean | null };
  if (u.banned) return null;
  return {
    userId: u.id,
    email: u.email,
    role: isRole(u.role) ? u.role : 'customer',
    emailVerified: u.emailVerified,
  };
}

/**
 * Resolve the session at most once per request. The rate limiter (onRequest) and the
 * guards (preValidation) both need it; the lookup is shared, never repeated.
 */
const resolved = new WeakMap<FastifyRequest, Promise<AuthContext | null>>();
export function getAuth(request: FastifyRequest): Promise<AuthContext | null> {
  let p = resolved.get(request);
  if (!p) {
    p = resolveAuth(request);
    resolved.set(request, p);
  }
  return p;
}

/**
 * Rate-limit identity: the signed-in user when there is a valid session, otherwise the
 * client IP (as resolved by Fastify under TRUST_PROXY). Separate namespaces so a user id
 * can never collide with an address.
 */
export async function rateLimitKey(request: FastifyRequest): Promise<string> {
  const a = await getAuth(request);
  return a ? `user:${a.userId}` : `ip:${request.ip}`;
}

export function requireUser(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

export function requireVendorCtx(request: FastifyRequest): VendorContext {
  if (!request.vendorCtx) throw new ForbiddenError('Vendor profile required', 'VENDOR_REQUIRED');
  return request.vendorCtx;
}

const authenticate: preValidationAsyncHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
  request.auth ??= await getAuth(request);
  if (!request.auth) throw new UnauthorizedError('Unauthorized — invalid or expired session');
};

function role(...allowed: Role[]): preValidationAsyncHookHandler {
  return async (request) => {
    const a = requireUser(request);
    if (!allowed.includes(a.role)) {
      throw new ForbiddenError(
        allowed.length === 1 && allowed[0] === 'customer' ? 'Only customer accounts can do this' : 'You do not have permission to do this',
        allowed.includes('customer') && !allowed.includes('vendor') ? 'CUSTOMERS_ONLY' : 'FORBIDDEN',
      );
    }
  };
}

const verifiedEmail: preValidationAsyncHookHandler = async (request) => {
  if (!requireUser(request).emailVerified) throw new ForbiddenError('Please verify your email first', 'EMAIL_NOT_VERIFIED');
};

interface VendorGuardOptions {
  /** Reject vendors suspended by an administrator. */
  active?: boolean;
  /** Reject vendors whose subscription no longer entitles paid functionality. */
  entitled?: boolean;
}

function vendor(opts: VendorGuardOptions = {}): preValidationAsyncHookHandler {
  return async (request) => {
    const a = requireUser(request);
    if (a.role !== 'vendor') throw new ForbiddenError('Vendor access required', 'VENDOR_REQUIRED');
    const v = await vendorsRepo.findByUserId(a.userId);
    if (!v) throw new ForbiddenError('Vendor profile not found — complete vendor onboarding first', 'VENDOR_REQUIRED');
    if (opts.active && v.status !== 'approved') throw new ForbiddenError('Your vendor account is suspended', 'VENDOR_SUSPENDED');
    const entitlement = await subscriptionsService.getEntitlement(v.id);
    if (opts.entitled && !entitlement.entitled) {
      throw new ForbiddenError('Your subscription is not active. Pay the outstanding invoice to continue.', 'SUBSCRIPTION_INACTIVE');
    }
    request.vendorCtx = { vendor: v, entitlement };
  };
}

/** Guard sets for route definitions. */
export const guards = {
  user: [authenticate],
  verifiedUser: [authenticate, verifiedEmail],
  admin: [authenticate, role('admin')],
  customer: [authenticate, verifiedEmail, role('customer')],
  /** Any vendor, including suspended or unentitled ones (profile, billing, read-only views). */
  vendor: [authenticate, role('vendor'), vendor()],
  /** Vendor not suspended by an admin (e.g. editing drafts, managing availability). */
  activeVendor: [authenticate, role('vendor'), vendor({ active: true })],
  /** Vendor not suspended and with an entitled subscription (publishing, accepting requests). */
  entitledVendor: [authenticate, role('vendor'), vendor({ active: true, entitled: true })],
  /** Customer or vendor party to a resource; the service checks the actual relationship. */
  party: [authenticate],
};

/** Populate `request.auth` without rejecting (public routes that show more to owners). */
export const optionalAuth: preValidationAsyncHookHandler = async (request) => {
  request.auth = await getAuth(request);
};
