import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { env } from './config/env';
import { authRoutes } from './modules/auth/auth.routes';
import { vendorRoutes, vendorAdminRoutes } from './modules/vendors/vendors.routes';
import { authenticate, requireAdmin, requireVendor } from './middleware/auth.middleware';
import { uploadRoutes } from './modules/upload/upload.routes';


export async function buildApp() {
  const fastify = Fastify({
    logger: true,
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(jwt, {
    secret: env.JWT_SECRET,
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
    },
  })

  await fastify.register(swagger, {
    swagger: {
      info: {
        title: 'Hospitality SaaS API',
        version: '1.0.0',
      },
      host: `localhost:${env.PORT}`,
      schemes: ['http', 'https'],
      consumes: ['application/json'],
      produces: ['application/json'],
    },
  });

  await fastify.register(swaggerUI, {
    routePrefix: '/docs',
  });

  // Decorate Fastify instance with authentication middleware
  fastify.decorate('authenticate', authenticate);
  fastify.decorate('requireAdmin', requireAdmin);
  fastify.decorate('requireVendor', requireVendor); 

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(vendorRoutes, { prefix: '/api/vendors' });
  await fastify.register(vendorAdminRoutes, { prefix: '/api/admin/vendors' });
  await fastify.register(uploadRoutes, { prefix: '/api/upload' });


  // TODO: Register other module routes

  return fastify;
}