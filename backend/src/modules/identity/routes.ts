import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth, BLOCKED_AUTH_PATHS } from './auth.js';
import { otpService } from './otp.service.js';
import { guards, requireUser } from '../../app/policies.js';
import { ForbiddenError } from '../../app/errors.js';

/**
 * Better Auth bridge (mounted at /api/auth). The raw request body is forwarded as-is
 * (the previous bridge re-serialised parsed JSON, breaking non-JSON posts).
 */
export const authBridge: FastifyPluginAsync = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const forward = async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? '';
    if (BLOCKED_AUTH_PATHS.has(path)) throw new ForbiddenError('This operation is not available', 'AUTH_OPERATION_DISABLED');

    const url = new URL(request.url, env_base());
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    // Better Auth reads the client IP from X-Forwarded-For (session records, its own
    // production rate limits). Give it the address Fastify resolved under TRUST_PROXY,
    // never a client-supplied header.
    headers.set('x-forwarded-for', request.ip);
    const body = request.method === 'GET' || request.body == null ? undefined : new Uint8Array(request.body as Buffer);
    const response = await auth.handler(new Request(url, { method: request.method, headers, ...(body ? { body } : {}) }));

    reply.status(response.status);
    for (const cookie of response.headers.getSetCookie()) reply.header('set-cookie', cookie);
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
    return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
  };

  // Password reset: tighter limits than the rest of auth (each request can send an email).
  app.post('/request-password-reset', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    schema: { tags: ['Auth (Better Auth)'], summary: 'Request a password-reset email: { email }. Always 200 with the same body, whether or not the account exists.' },
  }, forward);
  app.post('/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { tags: ['Auth (Better Auth)'], summary: 'Set a new password: { token, newPassword }. Token is single-use; 400 INVALID_TOKEN if unknown, used or expired.' },
  }, forward);

  app.route({
    method: ['GET', 'POST'],
    url: '/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['Auth (Better Auth)'], summary: 'Better Auth endpoints (sign-up/email, sign-in/email, sign-out, get-session, …). See docs/api/API-REFERENCE.md' },
    handler: forward,
  });
};

function env_base(): string {
  // Better Auth validates against its configured baseURL; build the URL on that origin.
  return new URL(auth.options.baseURL ?? 'http://localhost').origin;
}

/** Email verification (mounted at /api/otp). */
export const otpRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/verify-email', {
    preValidation: guards.user,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['Identity'], body: z.object({ otp: z.string().regex(/^\d{6}$/, 'Code must be 6 digits') }) },
  }, async (request) => {
    const user = await otpService.verify(requireUser(request).userId, request.body.otp);
    return { success: true, message: 'Email verified! Welcome to LinkMart.', data: { user } };
  });

  app.post('/resend-otp', {
    preValidation: guards.user,
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    schema: { tags: ['Identity'] },
  }, async (request) => {
    await otpService.resend(requireUser(request).userId);
    return { success: true, message: 'Verification code sent to your email.' };
  });
};
