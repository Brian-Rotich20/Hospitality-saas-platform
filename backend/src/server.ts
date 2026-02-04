// ✅ MUST BE FIRST - Load type augmentations before any other imports
import './types/fastify';

import Fastify from 'fastify';
import { buildApp } from './app';
import { env } from './config/env';


async function start() {
  try {
    const app = await buildApp();

    await app.listen({
      port: parseInt(env.PORT),
      host: env.HOST,
    });

    console.log(`
    🚀 Server running on http://${env.HOST}:${env.PORT}
    📚 API Docs: http://${env.HOST}:${env.PORT}/docs
    `);
  } catch (error) {
    console.error('❌ Error starting server:', error);
    process.exit(1);
  }
}

start();