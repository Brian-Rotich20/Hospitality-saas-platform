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
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { hashPassword } from './utils/password'; // adjust path if different
import { users }      from './db/schema/users';
import { categories } from './db/schema/categories'; // at top of file

import { eq } from 'drizzle-orm';
// ── Route imports 
import { authRoutes }                        from './modules/auth/auth.routes';
import { vendorRoutes, vendorAdminRoutes }   from './modules/vendors/vendors.routes';
import { uploadRoutes }                      from './modules/upload/upload.routes';
import { listingRoutes }                     from './modules/listings/listings.routes';
import { categoryRoutes }                    from './modules/categories/categories.routes';  // ✅ fixed
import { productRoutes }                     from './modules/products/products.routes';       // ✅ added
import { availabilityRoutes }                from './modules/availability/availability.routes';
import { bookingRoutes, bookingAdminRoutes } from './modules/bookings/bookings.routes';
import { payoutRoutes, payoutAdminRoutes }   from './modules/payouts/payouts.routes';

// ── Middleware 
import { authenticate, requireAdmin, requireVendor } from './middleware/auth.middleware';

export async function buildApp() {
  const fastify = Fastify({
  logger: {
    level: 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: { colorize: true },
    } : undefined,
  },
}).withTypeProvider<ZodTypeProvider>();

  const COOKIE_SECRET = process.env.COOKIE_SECRET;
  if (!COOKIE_SECRET) throw new Error('COOKIE_SECRET env variable is required');

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // ── Plugins 
  await fastify.register(cors, {
    origin: [
          'https://linkmart-olive.vercel.app', 
          'http://localhost:3000',              
        ],
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

  // Add temporarily to app.ts AFTER all other routes
// Remove this entire block after creating your admin account


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

  return fastify;
}