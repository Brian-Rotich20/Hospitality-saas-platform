import './types/fastify-augmentation';
import { buildApp } from './app';
import { env } from './config/env';

process.on('uncaughtException', (err: Error) => {
  console.error('[uncaughtException]', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

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
  } catch (err: unknown) {
    console.error('❌ Error starting server:', err instanceof Error ? err.stack : err);
    process.exit(1);
  }
}

start();