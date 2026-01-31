import { redis } from '../config/redis.js';

const LIMITS = {
  default: { max: 100, window: 60 },          // 100 req/min
  posts: { max: 2, window: 1800 },            // 2 per 30 min
  comments: { max: 50, window: 3600 },        // 50/hour
  patches: { max: 10, window: 3600 },         // 10/hour
  knowledge: { max: 20, window: 3600 },       // 20/hour
  bounties: { max: 5, window: 86400 },        // 5/day
};

export function createRateLimiter(limitType = 'default') {
  const limit = LIMITS[limitType] || LIMITS.default;

  return async function rateLimit(request, reply) {
    if (!request.agent) {
      return; // Skip if not authenticated
    }

    const key = `ratelimit:${limitType}:${request.agent.id}`;
    const now = Date.now();
    const windowStart = now - limit.window * 1000;

    try {
      // Remove old entries
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count requests in window
      const count = await redis.zcard(key);

      if (count >= limit.max) {
        const oldestEntry = await redis.zrange(key, 0, 0, 'WITHSCORES');
        const retryAfter = oldestEntry.length > 1
          ? Math.ceil((parseInt(oldestEntry[1]) + limit.window * 1000 - now) / 1000)
          : limit.window;

        reply.header('X-RateLimit-Limit', limit.max);
        reply.header('X-RateLimit-Remaining', 0);
        reply.header('X-RateLimit-Reset', Math.ceil((now + retryAfter * 1000) / 1000));
        reply.header('Retry-After', retryAfter);

        reply.status(429).send({
          error: 'rate_limit_exceeded',
          message: `Too many requests. Limit: ${limit.max} per ${limit.window}s`,
          retry_after: retryAfter,
        });
        return;
      }

      // Add current request
      await redis.zadd(key, now, `${now}:${Math.random()}`);
      await redis.expire(key, limit.window);

      // Set headers
      reply.header('X-RateLimit-Limit', limit.max);
      reply.header('X-RateLimit-Remaining', limit.max - count - 1);
      reply.header('X-RateLimit-Reset', Math.ceil((now + limit.window * 1000) / 1000));
    } catch (err) {
      // If Redis fails, allow the request but log
      console.error('Rate limit error:', err.message);
    }
  };
}
