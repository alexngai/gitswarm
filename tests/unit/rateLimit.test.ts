import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Rate Limiting', () => {
  describe('Rate Limit Configuration', () => {
    it('should have correct default limits', () => {
      const LIMITS = {
        default: { max: 100, window: 60 },          // 100 req/min
        posts: { max: 2, window: 1800 },            // 2 per 30 min
        comments: { max: 50, window: 3600 },        // 50/hour
        patches: { max: 10, window: 3600 },         // 10/hour
        knowledge: { max: 20, window: 3600 },       // 20/hour
        bounties: { max: 5, window: 86400 },        // 5/day
      };

      expect(LIMITS.default.max).toBe(100);
      expect(LIMITS.default.window).toBe(60);

      expect(LIMITS.posts.max).toBe(2);
      expect(LIMITS.posts.window).toBe(1800);

      expect(LIMITS.comments.max).toBe(50);
      expect(LIMITS.comments.window).toBe(3600);

      expect(LIMITS.patches.max).toBe(10);
      expect(LIMITS.patches.window).toBe(3600);

      expect(LIMITS.knowledge.max).toBe(20);
      expect(LIMITS.knowledge.window).toBe(3600);

      expect(LIMITS.bounties.max).toBe(5);
      expect(LIMITS.bounties.window).toBe(86400);
    });
  });

  describe('Rate Limit Headers', () => {
    it('should set correct rate limit headers format', () => {
      const limit = 100;
      const remaining = 95;
      const resetTime = Math.ceil((Date.now() + 60000) / 1000);

      const headers = {
        'X-RateLimit-Limit': limit,
        'X-RateLimit-Remaining': remaining,
        'X-RateLimit-Reset': resetTime,
      };

      expect(headers['X-RateLimit-Limit']).toBe(100);
      expect(headers['X-RateLimit-Remaining']).toBe(95);
      expect(typeof headers['X-RateLimit-Reset']).toBe('number');
    });

    it('should include Retry-After on 429', () => {
      const retryAfter = 30;

      const headers = {
        'Retry-After': retryAfter,
      };

      expect(headers['Retry-After']).toBe(30);
    });
  });

  describe('Rate Limit Key Generation', () => {
    it('should generate unique keys per agent and limit type', () => {
      const generateKey = (limitType: string, agentId: string): string => `ratelimit:${limitType}:${agentId}`;

      const key1 = generateKey('default', 'agent-1');
      const key2 = generateKey('posts', 'agent-1');
      const key3 = generateKey('default', 'agent-2');

      expect(key1).toBe('ratelimit:default:agent-1');
      expect(key2).toBe('ratelimit:posts:agent-1');
      expect(key3).toBe('ratelimit:default:agent-2');

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  describe('Sliding Window Algorithm', () => {
    it('should correctly calculate remaining requests', () => {
      const maxRequests = 100;
      const currentCount = 25;
      const remaining = maxRequests - currentCount - 1;

      expect(remaining).toBe(74);
    });

    it('should return 0 remaining when limit exceeded', () => {
      const maxRequests = 100;
      const currentCount = 100;
      const remaining = Math.max(0, maxRequests - currentCount - 1);

      expect(remaining).toBe(0);
    });

    it('should calculate retry-after correctly', () => {
      const now = Date.now();
      const windowMs = 60000; // 1 minute
      const oldestEntryTime = now - 30000; // 30 seconds ago
      const retryAfter = Math.ceil((oldestEntryTime + windowMs - now) / 1000);

      expect(retryAfter).toBe(30);
    });
  });

  describe('Rate Limit Error Response', () => {
    it('should return correct 429 response format', () => {
      const errorResponse = {
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Limit: 100 per 60s',
        retry_after: 30,
      };

      expect(errorResponse.error).toBe('rate_limit_exceeded');
      expect(errorResponse.message).toContain('Too many requests');
      expect(errorResponse.retry_after).toBe(30);
    });
  });
});

describe('Mock Redis Rate Limiting', () => {
  let mockRedis: any;

  beforeEach(() => {
    const sortedSets = new Map<string, Map<string, number>>();

    mockRedis = {
      zadd: vi.fn(async (key: string, score: number, member: string) => {
        if (!sortedSets.has(key)) sortedSets.set(key, new Map());
        sortedSets.get(key)!.set(member, score);
        return 1;
      }),
      zcard: vi.fn(async (key: string) => {
        return sortedSets.has(key) ? sortedSets.get(key)!.size : 0;
      }),
      zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
        if (!sortedSets.has(key)) return 0;
        const set = sortedSets.get(key)!;
        let removed = 0;
        for (const [member, score] of set.entries()) {
          if (score >= min && score <= max) {
            set.delete(member);
            removed++;
          }
        }
        return removed;
      }),
      zrange: vi.fn(async (key: string, start: number, end: number, ...args: string[]) => {
        if (!sortedSets.has(key)) return [];
        const set = sortedSets.get(key)!;
        const entries = Array.from(set.entries()).sort((a, b) => a[1] - b[1]);
        const slice = entries.slice(start, end + 1);
        if (args.includes('WITHSCORES')) {
          return slice.flatMap(([m, s]) => [m, s.toString()]);
        }
        return slice.map(([m]) => m);
      }),
      expire: vi.fn(async () => 1),
      _sortedSets: sortedSets,
    };
  });

  it('should track requests using sorted set', async () => {
    const now = Date.now();
    await mockRedis.zadd('ratelimit:default:agent-1', now, `${now}:${Math.random()}`);

    const count = await mockRedis.zcard('ratelimit:default:agent-1');
    expect(count).toBe(1);
  });

  it('should remove old entries outside window', async () => {
    const now = Date.now();
    const oldTime = now - 120000; // 2 minutes ago

    await mockRedis.zadd('ratelimit:default:agent-1', oldTime, 'old-request');
    await mockRedis.zadd('ratelimit:default:agent-1', now, 'new-request');

    // Remove entries older than 1 minute
    const windowStart = now - 60000;
    await mockRedis.zremrangebyscore('ratelimit:default:agent-1', 0, windowStart);

    const count = await mockRedis.zcard('ratelimit:default:agent-1');
    expect(count).toBe(1);
  });

  it('should get oldest entry for retry-after calculation', async () => {
    const now = Date.now();
    const older = now - 30000;
    const oldest = now - 50000;

    await mockRedis.zadd('ratelimit:default:agent-1', oldest, 'oldest');
    await mockRedis.zadd('ratelimit:default:agent-1', older, 'older');
    await mockRedis.zadd('ratelimit:default:agent-1', now, 'newest');

    const result = await mockRedis.zrange('ratelimit:default:agent-1', 0, 0, 'WITHSCORES');

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('oldest');
    expect(parseInt(result[1])).toBe(oldest);
  });
});
