import './types/fastify-augmentation';
import { db } from './config/database';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { env } from './config/env';
import { redis } from './config/redis';
import fastifyCookie from '@fastify/cookie';
import { sql } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

// ── Route imports 
import { authRoutes }                        from './modules/auth/auth.routes';
import { vendorRoutes, vendorAdminRoutes }   from './modules/vendors/vendors.routes';
import { uploadRoutes }                      from './modules/upload/upload.routes';
import { listingRoutes }                     from './modules/listings/listings.routes';
import { categoryRoutes }                    from './modules/categories/categories.routes';  // ✅ fixed
import { productRoutes }                     from './modules/products/products.routes';       // ✅ added
import { availabilityRoutes }                from './modules/availability/availability.routes';
import { bookingRoutes }                     from './modules/bookings/bookings.routes';
import { payoutRoutes, payoutAdminRoutes }   from './modules/payouts/payouts.routes';

// ── Middleware 
import { authenticate, requireAdmin, requireVendor } from './middleware/auth.middleware';

export async function buildApp() {
  const fastify = Fastify({
    logger: true,
  }).withTypeProvider<ZodTypeProvider>();

  const COOKIE_SECRET = process.env.COOKIE_SECRET;
  if (!COOKIE_SECRET) throw new Error('COOKIE_SECRET env variable is required');

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // ── Plugins 
  await fastify.register(cors, {
    origin:               true,
    methods:              ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:       ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    credentials:          true,
    preflightContinue:    false,
    optionsSuccessStatus: 204,
  });

  await fastify.register(jwt, { secret: env.JWT_SECRET });

  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  await fastify.register(swagger, {
    swagger: {
      info: { title: 'Hospitality SaaS API', version: '1.0.0' },
      consumes: ['application/json'],
      produces: ['application/json'],
    },
  });

  await fastify.register(swaggerUI, { routePrefix: '/docs' });

  await fastify.register(fastifyCookie, { secret: COOKIE_SECRET });

  // ── Decorators
  fastify.decorate('authenticate',  authenticate);
  fastify.decorate('requireAdmin',  requireAdmin);
  fastify.decorate('requireVendor', requireVendor);
  fastify.decorate('db',            db);

  // ── Health check 
  fastify.get('/health', async () => ({
    status: 'ok', timestamp: new Date().toISOString(),
  }));

  fastify.get('/api/dev/reset', async (_, reply) => {
  await db.execute(sql`ALTER TABLE listings DROP COLUMN IF EXISTS location`);
  return reply.send({ success: true, message: 'Done' });
  });

  // ── Routes
  await fastify.register(authRoutes,          { prefix: '/api/auth'           });
  await fastify.register(vendorRoutes,        { prefix: '/api/vendors'        });
  await fastify.register(vendorAdminRoutes,   { prefix: '/api/admin/vendors'  });
  await fastify.register(uploadRoutes,        { prefix: '/api/upload'         });
  await fastify.register(listingRoutes,       { prefix: '/api/listings'       });
  await fastify.register(categoryRoutes,      { prefix: '/api/categories'     }); 
  await fastify.register(productRoutes,       { prefix: '/api/products'       }); 
  await fastify.register(availabilityRoutes,  { prefix: '/api'                });
  await fastify.register(bookingRoutes,       { prefix: '/api/bookings'       });
  await fastify.register(payoutRoutes,        { prefix: '/api/payouts'        });
  await fastify.register(payoutAdminRoutes,   { prefix: '/api/admin/payouts'  });

  return fastify;
}