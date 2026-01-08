import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.REDIS_URL);

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

// Helper functions
export const setCache = async (key: string, value: any, ttl: number = 3600) => {
  await redis.set(key, JSON.stringify(value), 'EX', ttl);
};

export const getCache = async (key: string) => {
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
};

export const delCache = async (key: string) => {
  await redis.del(key);
};