// HTTP application assembly. No business logic here.
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { env } from '../platform/config/env.js';
import { loggerOptions } from '../platform/logger.js';
import { pingDatabase } from '../platform/database/client.js';
import { pingRedis, redis } from '../platform/cache/redis.js';
import { registerErrorHandling } from './error-handler.js';
import { rateLimitKey } from './policies.js';

import { authBridge, otpRoutes } from '../modules/identity/routes.js';
import { userRoutes, customerAdminRoutes } from '../modules/users/routes.js';
import { vendorRoutes, vendorAdminRoutes } from '../modules/vendors/routes.js';
import { subscriptionRoutes, subscriptionAdminRoutes } from '../modules/subscriptions/routes.js';
import { paymentWebhookRoutes, paymentAdminRoutes } from '../modules/payments/routes.js';
import { listingRoutes } from '../modules/catalog/listings.routes.js';
import { categoryRoutes } from '../modules/catalog/categories.routes.js';
import { availabilityRoutes } from '../modules/availability/routes.js';
import { bookingRoutes, bookingAdminRoutes } from '../modules/bookings/routes.js';
import { conversationRoutes, messageRoutes, messageAdminRoutes } from '../modules/messaging/routes.js';
import { reviewRoutes } from '../modules/reviews/routes.js';
import { uploadRoutes } from '../modules/uploads/routes.js';
import { operationsAdminRoutes } from '../modules/operations/routes.js';

/** Trust exactly `n` proxy hops in front of the API (hop 0 is the direct peer). */
const trustHops = (n: number) => (_address: string, hop: number) => hop < n;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w-]{8,64}$/.test(given) ? given : randomUUID();
    },
    // A hop count is passed as the equivalent trust function (what Fastify builds from a
    // number internally); IP/CIDR lists and `false` are passed through.
    trustProxy: typeof env.TRUST_PROXY === 'number' ? trustHops(env.TRUST_PROXY) : env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.decorateRequest('vendorCtx', null);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // JSON API baseline hardening (no HTML is served except the optional /docs UI).
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (!request.url.startsWith('/docs')) reply.header('x-frame-options', 'DENY');
  });
  registerErrorHandling(app);

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(multipart, { limits: { fileSize: env.MAX_FILE_SIZE, files: 10, fields: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    enableDraftSpec: true,
    ...(env.RATE_LIMIT_ENABLED ? { redis, skipOnError: true } : { allowList: () => true }),
    // Runs at onRequest, before the guards, so the session is resolved here (once; the
    // guards reuse it). Signed-in callers are limited per user, anonymous ones per client IP.
    keyGenerator: rateLimitKey,
  });

  if (env.SWAGGER_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'LinkMart API',
          version: '2.0.0',
          description: 'Hospitality marketplace API. Successful responses are `{ success: true, data, ...extra }`; errors are `{ success: false, error, code, details?, requestId }`. '
            + 'Authentication is the Better Auth session cookie (send requests with credentials). LinkMart processes vendor subscription payments only; bookings carry no money.',
        },
        components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' } } },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUI, { routePrefix: '/docs' });
  }

  // Liveness: the process is up. Readiness: dependencies reachable.
  app.get('/health', { config: { rateLimit: false }, schema: { tags: ['Health'] } }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/ready', { config: { rateLimit: false }, schema: { tags: ['Health'] } }, async (_request, reply) => {
    const [database, cacheOk] = await Promise.all([pingDatabase(), pingRedis()]);
    // Redis is optional for serving (cache degrades to misses); the database is not.
    reply.code(database ? 200 : 503);
    return { status: database ? 'ready' : 'not_ready', database, redis: cacheOk };
  });

  await app.register(authBridge, { prefix: '/api/auth' });
  await app.register(otpRoutes, { prefix: '/api/otp' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(vendorRoutes, { prefix: '/api/vendors' });
  await app.register(subscriptionRoutes, { prefix: '/api/subscriptions' });
  await app.register(paymentWebhookRoutes, { prefix: '/api/payments' });
  await app.register(listingRoutes, { prefix: '/api/listings' });
  await app.register(categoryRoutes, { prefix: '/api/categories' });
  await app.register(availabilityRoutes, { prefix: '/api' });
  await app.register(bookingRoutes, { prefix: '/api/bookings' });
  await app.register(conversationRoutes, { prefix: '/api/conversations' });
  await app.register(messageRoutes, { prefix: '/api/messages' });
  await app.register(reviewRoutes, { prefix: '/api/reviews' });
  await app.register(uploadRoutes, { prefix: '/api/upload' });

  await app.register(customerAdminRoutes, { prefix: '/api/admin/customers' });
  await app.register(vendorAdminRoutes, { prefix: '/api/admin/vendors' });
  await app.register(subscriptionAdminRoutes, { prefix: '/api/admin/subscriptions' });
  await app.register(paymentAdminRoutes, { prefix: '/api/admin/payments' });
  await app.register(operationsAdminRoutes, { prefix: '/api/admin/operations' });
  await app.register(bookingAdminRoutes, { prefix: '/api/admin/bookings' });
  await app.register(messageAdminRoutes, { prefix: '/api/admin/messages' });

  return app;
}
