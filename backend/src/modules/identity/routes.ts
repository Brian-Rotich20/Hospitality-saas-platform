import type { FastifyPluginAsync } from 'fastify';
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

  app.route({
    method: ['GET', 'POST'],
    url: '/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['Auth (Better Auth)'], summary: 'Better Auth endpoints (sign-up/email, sign-in/email, sign-out, get-session, …). See docs/api/API-REFERENCE.md' },
    async handler(request, reply) {
      const path = request.url.split('?')[0] ?? '';
      if (BLOCKED_AUTH_PATHS.has(path)) throw new ForbiddenError('This operation is not available', 'AUTH_OPERATION_DISABLED');

      const url = new URL(request.url, env_base());
      const headers = new Headers();
      for (const [k, v] of Object.entries(request.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const body = request.method === 'GET' || request.body == null ? undefined : new Uint8Array(request.body as Buffer);
      const response = await auth.handler(new Request(url, { method: request.method, headers, ...(body ? { body } : {}) }));

      reply.status(response.status);
      for (const cookie of response.headers.getSetCookie()) reply.header('set-cookie', cookie);
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
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
