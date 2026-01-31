import Redis from 'ioredis';
import { config } from './env.js';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

export async function testConnection() {
  try {
    await redis.connect();
    await redis.ping();
    console.log('Redis connection verified');
    return true;
  } catch (err) {
    console.error('Redis connection failed:', err.message);
    return false;
  }
}
