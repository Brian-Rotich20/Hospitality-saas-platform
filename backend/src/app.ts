import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { env } from './config/env';
import { authRoutes } from './modules/auth/auth.routes';

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

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });

  // TODO: Register other module routes

  return fastify;
}