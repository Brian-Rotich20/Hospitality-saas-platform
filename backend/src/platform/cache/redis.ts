// Redis connections and a failure-tolerant cache.
//
// The cache is an optimisation only: every operation has a short timeout and any failure
// is logged and treated as a miss, so Redis being slow or down degrades latency, not
// availability. BullMQ needs its own connection settings (maxRetriesPerRequest: null).
import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const base: RedisOptions = { lazyConnect: false, enableReadyCheck: true };

/** Cache and rate-limit connection: fail fast instead of queueing commands while offline. */
export const redis = new Redis(env.REDIS_URL, {
  ...base,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectionName: 'linkmart-cache',
});
redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis cache connection error'));

/** Connection options for BullMQ queues and workers. */
export function queueConnection(): Redis {
  const conn = new Redis(env.REDIS_URL, { ...base, maxRetriesPerRequest: null, connectionName: 'linkmart-queue' });
  conn.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis queue connection error'));
  return conn;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cache timeout')), env.CACHE_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await withTimeout(redis.get(key));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      logger.debug({ key, err: (err as Error).message }, 'cache get failed (treated as miss)');
      return null;
    }
  },
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await withTimeout(redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
    } catch (err) {
      logger.debug({ key, err: (err as Error).message }, 'cache set failed');
    }
  },
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await withTimeout(redis.del(...keys));
    } catch (err) {
      logger.warn({ keys, err: (err as Error).message }, 'cache invalidation failed');
    }
  },
  /** Version counters let a whole family of keys be invalidated with one INCR. */
  async version(namespace: string): Promise<string> {
    try {
      const v = await withTimeout(redis.get(`v:${namespace}`));
      return v ?? '0';
    } catch {
      return 'nocache';
    }
  },
  async bump(namespace: string): Promise<void> {
    try {
      await withTimeout(redis.incr(`v:${namespace}`));
    } catch (err) {
      logger.warn({ namespace, err: (err as Error).message }, 'cache version bump failed');
    }
  },
};

export async function pingRedis(): Promise<boolean> {
  try {
    return (await withTimeout(redis.ping())) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
