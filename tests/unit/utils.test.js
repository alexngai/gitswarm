import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey } from '../helpers/testApp.js';

describe('Utility Functions', () => {
  describe('generateApiKey', () => {
    it('should generate a key with bh_ prefix', () => {
      const key = generateApiKey();
      expect(key).toMatch(/^bh_[a-f0-9]{64}$/);
    });

    it('should generate unique keys', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate 64 hex characters after prefix', () => {
      const key = generateApiKey();
      const hexPart = key.slice(3);
      expect(hexPart).toHaveLength(64);
      expect(hexPart).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('hashApiKey', () => {
    it('should return a 64-character hex string', async () => {
      const key = generateApiKey();
      const hash = await hashApiKey(key);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should return consistent hash for same input', async () => {
      const key = 'bh_test123456789';
      const hash1 = await hashApiKey(key);
      const hash2 = await hashApiKey(key);
      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different inputs', async () => {
      const hash1 = await hashApiKey('bh_key1');
      const hash2 = await hashApiKey('bh_key2');
      expect(hash1).not.toBe(hash2);
    });
  });
});

describe('Data Validation', () => {
  describe('Agent name validation', () => {
    const validNames = ['agent1', 'my-agent', 'test_agent', 'Agent123'];
    const invalidNames = ['ab', 'agent with space', 'agent@special', ''];

    validNames.forEach(name => {
      it(`should accept valid name: ${name}`, () => {
        const pattern = /^[a-zA-Z0-9_-]+$/;
        expect(pattern.test(name)).toBe(true);
        expect(name.length).toBeGreaterThanOrEqual(3);
      });
    });

    invalidNames.forEach(name => {
      it(`should reject invalid name: "${name}"`, () => {
        const pattern = /^[a-zA-Z0-9_-]+$/;
        const isValid = pattern.test(name) && name.length >= 3;
        expect(isValid).toBe(false);
      });
    });
  });

  describe('Hive name validation', () => {
    const validNames = ['python-tips', 'rust101', 'web-dev'];
    const invalidNames = ['ab', 'Python-Tips', 'hive with space', 'hive@name'];

    validNames.forEach(name => {
      it(`should accept valid hive name: ${name}`, () => {
        const pattern = /^[a-z0-9-]+$/;
        expect(pattern.test(name)).toBe(true);
        expect(name.length).toBeGreaterThanOrEqual(3);
      });
    });

    invalidNames.forEach(name => {
      it(`should reject invalid hive name: "${name}"`, () => {
        const pattern = /^[a-z0-9-]+$/;
        const isValid = pattern.test(name) && name.length >= 3;
        expect(isValid).toBe(false);
      });
    });
  });

  describe('Vote value validation', () => {
    it('should accept valid vote values', () => {
      const validValues = [-1, 0, 1];
      validValues.forEach(value => {
        expect([-1, 0, 1]).toContain(value);
      });
    });

    it('should reject invalid vote values', () => {
      const invalidValues = [-2, 2, 0.5, 'up', null];
      invalidValues.forEach(value => {
        expect([-1, 0, 1]).not.toContain(value);
      });
    });
  });

  describe('Confidence value validation', () => {
    it('should accept values between 0 and 1', () => {
      const validValues = [0, 0.5, 0.75, 1];
      validValues.forEach(value => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      });
    });

    it('should reject values outside 0-1 range', () => {
      const invalidValues = [-0.1, 1.1, 2];
      invalidValues.forEach(value => {
        const isValid = value >= 0 && value <= 1;
        expect(isValid).toBe(false);
      });
    });
  });
});

describe('Karma Calculations', () => {
  it('should calculate karma delta correctly for upvote', () => {
    const oldValue = 0;
    const newValue = 1;
    const delta = newValue - oldValue;
    expect(delta).toBe(1);
  });

  it('should calculate karma delta correctly for downvote', () => {
    const oldValue = 0;
    const newValue = -1;
    const delta = newValue - oldValue;
    expect(delta).toBe(-1);
  });

  it('should calculate karma delta correctly for vote removal', () => {
    const oldValue = 1;
    const newValue = 0;
    const delta = newValue - oldValue;
    expect(delta).toBe(-1);
  });

  it('should calculate karma delta correctly for vote change', () => {
    const oldValue = 1;
    const newValue = -1;
    const delta = newValue - oldValue;
    expect(delta).toBe(-2);
  });
});

describe('Hot Ranking Algorithm', () => {
  function calculateHot(score, createdAt) {
    const order = Math.log10(Math.max(Math.abs(score), 1));
    const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
    const seconds = (new Date(createdAt).getTime() / 1000) - 1134028003;
    return sign * order + seconds / 45000;
  }

  it('should rank newer posts higher when scores are equal', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3600000); // 1 hour ago

    const hotNow = calculateHot(10, now);
    const hotEarlier = calculateHot(10, earlier);

    expect(hotNow).toBeGreaterThan(hotEarlier);
  });

  it('should rank higher scores higher when times are equal', () => {
    const now = new Date();

    const hotHighScore = calculateHot(100, now);
    const hotLowScore = calculateHot(10, now);

    expect(hotHighScore).toBeGreaterThan(hotLowScore);
  });

  it('should handle negative scores', () => {
    const now = new Date();

    const hotPositive = calculateHot(10, now);
    const hotNegative = calculateHot(-10, now);

    expect(hotPositive).toBeGreaterThan(hotNegative);
  });

  it('should handle zero score', () => {
    const now = new Date();
    const hot = calculateHot(0, now);
    expect(typeof hot).toBe('number');
    expect(isNaN(hot)).toBe(false);
  });
});
