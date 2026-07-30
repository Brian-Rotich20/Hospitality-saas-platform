import './types/fastify-augmentation.js';
import { db } from './config/database.js';
import Fastify from 'fastify';
import { env } from './config/env.js';
import cors from '@fastify/cors';
import {  auth } from './config/auth.js';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { hashPassword } from './utils/password.js'; // adjust path if different
import { users }      from './db/schema/users.js';
import { categories } from './db/schema/categories.js'; // at top of file
import { eq } from 'drizzle-orm';

// ── Route imports 
import { authRoutes }                        from './modules/auth/auth.routes.js';
import { vendorRoutes, vendorAdminRoutes }   from './modules/vendors/vendors.routes.js';
import { uploadRoutes }                      from './modules/upload/upload.routes.js';
import { listingRoutes }                     from './modules/listings/listings.routes.js';
import { categoryRoutes }                    from './modules/categories/categories.routes.js';  // ✅ fixed
import { productRoutes }                     from './modules/products/products.routes.js';       // ✅ added
import { availabilityRoutes }                from './modules/availability/availability.routes.js';
import { bookingRoutes, bookingAdminRoutes } from './modules/bookings/bookings.routes.js';
import { payoutRoutes, payoutAdminRoutes }   from './modules/payouts/payouts.routes.js';
import { reviewRoutes } from './modules/reviews/reviews.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
// ── Middleware 
import { authenticate, requireAdmin, requireVendor, requireVerified } from './middleware/auth.middleware.js';

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
    origin: [
          'https://linkmart-olive.vercel.app', 'http://localhost:3000',           
        ],
    methods:              ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:       ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    credentials:          true,
    preflightContinue:    false,
    optionsSuccessStatus: 204,
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      reply.send();
    }
  });

  await fastify.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET ?? 'changeme',
  });
 
  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });
  
  fastify.get('/api/dev/seed', async (_, reply) => {
  await db.insert(categories).values([
    { name: 'Venues',        slug: 'venues',        icon: 'Building2'     },
    { name: 'Catering',      slug: 'catering',      icon: 'Utensils'      },
    { name: 'Photography',   slug: 'photography',   icon: 'Camera'        },
    { name: 'Music & DJ',    slug: 'music',         icon: 'Music'         },
    { name: 'Décor',         slug: 'decor',         icon: 'Flower2'       },
    { name: 'Transport',     slug: 'transport',     icon: 'Bus'           },
    { name: 'Entertainment', slug: 'entertainment', icon: 'MoreHorizontal'},
    { name: 'Education',     slug: 'education',     icon: 'BookOpen'      },
  ]).onConflictDoNothing();

  return reply.send({ success: true, message: 'Categories seeded' });
  });

  await fastify.register(swagger, {
    swagger: {
      info: { title: 'Hospitality SaaS API', version: '1.0.0' },
      consumes: ['application/json'],
      produces: ['application/json'],
    },
  });

  await fastify.register(swaggerUI, { routePrefix: '/docs' });

    fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);

        const headers = new Headers();
        Object.entries(request.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });

        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          body: request.method !== 'GET' && request.method !== 'HEAD'
            ? JSON.stringify(request.body)
            : null,
        });

        const response = await auth.handler(req);

        reply.status(response.status);
        response.headers.forEach((value, key) => reply.header(key, value));
        const body = response.body ? await response.text() : null;
        reply.send(body);
      } catch (err) {
        fastify.log.error(err, 'Better Auth handler error');
        reply.status(500).send({ error: 'Internal authentication error' });
      }
    },
  });

  // ── Decorators
  fastify.decorate('authenticate',  authenticate);
  fastify.decorate('requireAdmin',  requireAdmin);
  fastify.decorate('requireVendor', requireVendor);
  fastify.decorate('requireVerified', requireVerified);
  fastify.decorate('db',            db);


  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    fastify.log.error({ err: error, url: request.url }, 'Unhandled error');
    reply.status(error.statusCode ?? 500).send({
      statusCode: error.statusCode ?? 500,
      error: 'Internal Server Error',
      message: error.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack }),
    });
  });

  // ── Health check 
  fastify.get('/health', async () => ({
    status: 'ok', timestamp: new Date().toISOString(),
  }));


  fastify.post('/api/dev/seed-admin', async (req, reply) => {
    // Only works in non-production AND only if no admin exists yet
    if (process.env.NODE_ENV === 'production') {
      return reply.code(403).send({ success: false, error: 'Not available in production' });
    }

    const { email, password, fullName } = req.body as {
      email:    string;
      password: string;
      fullName: string;
    };

    if (!email || !password || !fullName) {
      return reply.code(400).send({ success: false, error: 'email, password and fullName required' });
    }

    // Check if admin already exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existing) {
      // If user exists, just promote to admin
      await db.update(users)
        .set({ role: 'admin' })
        .where(eq(users.email, email));
      return reply.send({ success: true, message: `${email} promoted to admin` });
    }

    // Create fresh admin account
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({
      fullName,
      email,
      passwordHash,
      role:  'admin',
      phone: '+254700000000', // placeholder
    });

    return reply.send({ success: true, message: `Admin account created for ${email}` });
  });

  // ── Routes
  await fastify.register(authRoutes,          { prefix: '/api/auth'           });
  await fastify.register(otpRoutes,           { prefix: '/api/auth/otp'       });
  await fastify.register(vendorRoutes,        { prefix: '/api/vendors'        });
  await fastify.register(vendorAdminRoutes,   { prefix: '/api/admin/vendors'  });
  await fastify.register(uploadRoutes,        { prefix: '/api/upload'         });
  await fastify.register(listingRoutes,       { prefix: '/api/listings'       });
  await fastify.register(categoryRoutes,      { prefix: '/api/categories'     }); 
  await fastify.register(productRoutes,       { prefix: '/api/products'       }); 
  await fastify.register(availabilityRoutes,  { prefix: '/api'                });
  await fastify.register(bookingRoutes,       { prefix: '/api/bookings'       });
  await fastify.register(bookingAdminRoutes,  { prefix: '/api/admin/bookings' });
  await fastify.register(payoutRoutes,        { prefix: '/api/payouts'        });
  await fastify.register(payoutAdminRoutes,   { prefix: '/api/admin/payouts'  });
  await fastify.register(reviewRoutes, { prefix: '/api/reviews' });
  await fastify.register(userRoutes, { prefix: '/api/users' });

  return fastify;
}