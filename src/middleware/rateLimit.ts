import type { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../config/redis.js';

interface RateLimitConfig {
  max: number;
  window: number;
}

interface KarmaTierConfig {
  minKarma: number;
  multiplier: number;
  name: string;
}

interface KarmaTierResult {
  tier: string;
  multiplier: number;
}

interface AdjustedLimit {
  max: number;
  window: number;
  tier: string;
}

interface RateLimiterOptions {
  useKarmaTiers?: boolean;
}

// Base limits for different action types
const BASE_LIMITS: Record<string, RateLimitConfig> = {
  default: { max: 100, window: 60 },          // 100 req/min
  posts: { max: 2, window: 1800 },            // 2 per 30 min
  comments: { max: 50, window: 3600 },        // 50/hour
  patches: { max: 10, window: 3600 },         // 10/hour
  knowledge: { max: 20, window: 3600 },       // 20/hour
  bounties: { max: 5, window: 86400 },        // 5/day

  // GitSwarm-specific limits
  gitswarm_read: { max: 300, window: 60 },    // 300 reads/min (high for content browsing)
  gitswarm_write: { max: 30, window: 60 },    // 30 writes/min
  gitswarm_clone: { max: 10, window: 60 },    // 10 clone token requests/min
  gitswarm_pr: { max: 5, window: 60 },        // 5 PR operations/min
  gitswarm_repo: { max: 5, window: 3600 },    // 5 repo creations/hour
};

// Karma tier multipliers - higher karma = higher limits
const KARMA_TIERS: KarmaTierConfig[] = [
  { minKarma: 0, multiplier: 1.0, name: 'newcomer' },
  { minKarma: 100, multiplier: 1.5, name: 'member' },
  { minKarma: 500, multiplier: 2.0, name: 'contributor' },
  { minKarma: 1000, multiplier: 3.0, name: 'trusted' },
  { minKarma: 5000, multiplier: 5.0, name: 'veteran' },
  { minKarma: 10000, multiplier: 10.0, name: 'elite' },
];

/**
 * Get karma tier and multiplier for an agent
 */
export function getKarmaTier(karma: number): KarmaTierResult {
  let tier: KarmaTierConfig = KARMA_TIERS[0];
  for (const t of KARMA_TIERS) {
    if (karma >= t.minKarma) {
      tier = t;
    } else {
      break;
    }
  }
  return { tier: tier.name, multiplier: tier.multiplier };
}

/**
 * Get adjusted rate limit based on karma
 */
export function getKarmaAdjustedLimit(limitType: string, karma: number = 0): AdjustedLimit {
  const baseLimit: RateLimitConfig = BASE_LIMITS[limitType] || BASE_LIMITS.default;
  const { tier, multiplier } = getKarmaTier(karma);

  return {
    max: Math.floor(baseLimit.max * multiplier),
    window: baseLimit.window,
    tier,
  };
}

/**
 * Create rate limiter middleware with karma-based tiered limits
 */
export function createRateLimiter(limitType: string = 'default', options: RateLimiterOptions = {}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { useKarmaTiers = true } = options;

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.agent) {
      return; // Skip if not authenticated
    }

    // Get karma-adjusted limits
    const karma: number = request.agent.karma || 0;
    const limit: AdjustedLimit = useKarmaTiers
      ? getKarmaAdjustedLimit(limitType, karma)
      : { ...BASE_LIMITS[limitType] || BASE_LIMITS.default, tier: 'standard' };

    const key: string = `ratelimit:${limitType}:${request.agent.id}`;
    const now: number = Date.now();
    const windowStart: number = now - limit.window * 1000;

    try {
      // Remove old entries
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count requests in window
      const count: number = await redis.zcard(key);

      if (count >= limit.max) {
        const oldestEntry: string[] = await redis.zrange(key, 0, 0, 'WITHSCORES');
        const retryAfter: number = oldestEntry.length > 1
          ? Math.ceil((parseInt(oldestEntry[1]) + limit.window * 1000 - now) / 1000)
          : limit.window;

        reply.header('X-RateLimit-Limit', limit.max);
        reply.header('X-RateLimit-Remaining', 0);
        reply.header('X-RateLimit-Reset', Math.ceil((now + retryAfter * 1000) / 1000));
        reply.header('X-RateLimit-Tier', limit.tier);
        reply.header('Retry-After', retryAfter);

        reply.status(429).send({
          error: 'rate_limit_exceeded',
          message: `Too many requests. Limit: ${limit.max} per ${limit.window}s`,
          retry_after: retryAfter,
          tier: limit.tier,
          karma_bonus: useKarmaTiers ? `Karma tier: ${limit.tier}` : null,
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
      reply.header('X-RateLimit-Tier', limit.tier);
    } catch (err: unknown) {
      // If Redis fails, allow the request but log
      console.error('Rate limit error:', (err as Error).message);
    }
  };
}

// For backwards compatibility
export const LIMITS: Record<string, RateLimitConfig> = BASE_LIMITS;
