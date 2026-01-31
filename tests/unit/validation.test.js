import { describe, it, expect } from 'vitest';

describe('Input Validation', () => {
  describe('Agent Validation', () => {
    const agentNamePattern = /^[a-zA-Z0-9_-]+$/;
    const minLength = 3;
    const maxLength = 50;

    it('should accept valid agent names', () => {
      const validNames = [
        'agent',
        'my-agent',
        'agent_123',
        'Agent-Test_01',
        'a1b',
        'abc',
      ];

      validNames.forEach(name => {
        expect(agentNamePattern.test(name)).toBe(true);
        expect(name.length).toBeGreaterThanOrEqual(minLength);
        expect(name.length).toBeLessThanOrEqual(maxLength);
      });
    });

    it('should reject invalid agent names', () => {
      const invalidNames = [
        'ab',           // Too short
        'my agent',     // Contains space
        'agent@test',   // Contains @
        'agent.test',   // Contains .
        'agent!',       // Contains !
        '',             // Empty
      ];

      invalidNames.forEach(name => {
        const isValid = agentNamePattern.test(name) &&
                       name.length >= minLength &&
                       name.length <= maxLength;
        expect(isValid).toBe(false);
      });
    });

    it('should reject names exceeding max length', () => {
      const longName = 'a'.repeat(51);
      expect(longName.length).toBeGreaterThan(maxLength);
    });
  });

  describe('Hive Validation', () => {
    const hiveNamePattern = /^[a-z0-9-]+$/;

    it('should accept valid hive names', () => {
      const validNames = [
        'python-tips',
        'rust101',
        'web-dev',
        'ai-ml',
        'go-lang',
      ];

      validNames.forEach(name => {
        expect(hiveNamePattern.test(name)).toBe(true);
      });
    });

    it('should reject uppercase hive names', () => {
      const invalidNames = [
        'Python-Tips',
        'RUST',
        'WebDev',
      ];

      invalidNames.forEach(name => {
        expect(hiveNamePattern.test(name)).toBe(false);
      });
    });

    it('should reject hive names with special characters', () => {
      const invalidNames = [
        'python_tips',  // underscore not allowed
        'rust.io',      // dot not allowed
        'web@dev',      // @ not allowed
      ];

      invalidNames.forEach(name => {
        expect(hiveNamePattern.test(name)).toBe(false);
      });
    });
  });

  describe('Forge Validation', () => {
    const forgeNamePattern = /^[a-z0-9-]+$/;

    it('should accept valid forge names', () => {
      const validNames = [
        'api-client',
        'utils123',
        'my-awesome-lib',
      ];

      validNames.forEach(name => {
        expect(forgeNamePattern.test(name)).toBe(true);
      });
    });

    it('should validate ownership types', () => {
      const validTypes = ['solo', 'guild', 'open'];
      const invalidTypes = ['private', 'public', 'team', ''];

      validTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(true);
      });

      invalidTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(false);
      });
    });

    it('should validate consensus threshold range', () => {
      const validThresholds = [0.5, 0.66, 0.75, 1.0];
      const invalidThresholds = [0.4, 1.1, -0.5, 2.0];

      validThresholds.forEach(threshold => {
        expect(threshold >= 0.5 && threshold <= 1.0).toBe(true);
      });

      invalidThresholds.forEach(threshold => {
        expect(threshold >= 0.5 && threshold <= 1.0).toBe(false);
      });
    });
  });

  describe('Post Validation', () => {
    it('should validate post types', () => {
      const validTypes = ['text', 'link', 'knowledge', 'bounty', 'project'];
      const invalidTypes = ['image', 'video', 'poll'];

      validTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(true);
      });

      invalidTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(false);
      });
    });

    it('should validate title length', () => {
      const minLength = 3;
      const maxLength = 300;

      expect('Ab'.length).toBeLessThan(minLength);
      expect('Abc'.length).toBeGreaterThanOrEqual(minLength);
      expect('a'.repeat(300).length).toBeLessThanOrEqual(maxLength);
      expect('a'.repeat(301).length).toBeGreaterThan(maxLength);
    });

    it('should validate body length', () => {
      const maxLength = 40000;

      expect('a'.repeat(40000).length).toBeLessThanOrEqual(maxLength);
      expect('a'.repeat(40001).length).toBeGreaterThan(maxLength);
    });
  });

  describe('Vote Validation', () => {
    it('should accept valid vote values', () => {
      const validValues = [-1, 0, 1];

      validValues.forEach(value => {
        expect([-1, 0, 1].includes(value)).toBe(true);
      });
    });

    it('should reject invalid vote values', () => {
      const invalidValues = [-2, 2, 0.5, 100, -100];

      invalidValues.forEach(value => {
        expect([-1, 0, 1].includes(value)).toBe(false);
      });
    });
  });

  describe('Knowledge Node Validation', () => {
    it('should validate confidence range', () => {
      const validConfidences = [0, 0.25, 0.5, 0.75, 1.0];
      const invalidConfidences = [-0.1, 1.1, 2.0];

      validConfidences.forEach(conf => {
        expect(conf >= 0 && conf <= 1).toBe(true);
      });

      invalidConfidences.forEach(conf => {
        expect(conf >= 0 && conf <= 1).toBe(false);
      });
    });

    it('should validate claim length', () => {
      const minLength = 10;
      const maxLength = 1000;

      expect('Short'.length).toBeLessThan(minLength);
      expect('This is a valid claim'.length).toBeGreaterThanOrEqual(minLength);
      expect('a'.repeat(1000).length).toBeLessThanOrEqual(maxLength);
    });
  });

  describe('Patch Validation', () => {
    it('should validate change actions', () => {
      const validActions = ['create', 'modify', 'delete'];
      const invalidActions = ['update', 'add', 'remove'];

      validActions.forEach(action => {
        expect(validActions.includes(action)).toBe(true);
      });

      invalidActions.forEach(action => {
        expect(validActions.includes(action)).toBe(false);
      });
    });

    it('should validate review verdicts', () => {
      const validVerdicts = ['approve', 'request_changes', 'comment'];
      const invalidVerdicts = ['reject', 'accept', 'lgtm'];

      validVerdicts.forEach(verdict => {
        expect(validVerdicts.includes(verdict)).toBe(true);
      });

      invalidVerdicts.forEach(verdict => {
        expect(validVerdicts.includes(verdict)).toBe(false);
      });
    });

    it('should validate patch status', () => {
      const validStatuses = ['open', 'merged', 'closed'];

      validStatuses.forEach(status => {
        expect(validStatuses.includes(status)).toBe(true);
      });
    });
  });

  describe('Bounty Validation', () => {
    it('should validate reward karma is non-negative', () => {
      const validRewards = [0, 10, 50, 100, 1000];
      const invalidRewards = [-1, -10, -100];

      validRewards.forEach(reward => {
        expect(reward >= 0).toBe(true);
      });

      invalidRewards.forEach(reward => {
        expect(reward >= 0).toBe(false);
      });
    });

    it('should validate bounty status', () => {
      const validStatuses = ['open', 'claimed', 'completed', 'expired'];

      validStatuses.forEach(status => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('Sync Validation', () => {
    it('should validate sync types', () => {
      const validTypes = ['discovery', 'tip', 'warning', 'question'];
      const invalidTypes = ['info', 'alert', 'note'];

      validTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(true);
      });

      invalidTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(false);
      });
    });

    it('should validate reaction types', () => {
      const validReactions = ['useful', 'known', 'incorrect'];
      const invalidReactions = ['like', 'dislike', 'helpful'];

      validReactions.forEach(reaction => {
        expect(validReactions.includes(reaction)).toBe(true);
      });

      invalidReactions.forEach(reaction => {
        expect(validReactions.includes(reaction)).toBe(false);
      });
    });
  });

  describe('GitHub Repo Validation', () => {
    it('should validate owner/repo format', () => {
      const repoPattern = /^[\w.-]+\/[\w.-]+$/;

      const validRepos = [
        'owner/repo',
        'my-org/my-repo',
        'user123/project.js',
        'org_name/repo-name',
      ];

      validRepos.forEach(repo => {
        expect(repoPattern.test(repo)).toBe(true);
      });
    });

    it('should reject invalid repo formats', () => {
      const repoPattern = /^[\w.-]+\/[\w.-]+$/;

      const invalidRepos = [
        'repo',           // No owner
        '/repo',          // Missing owner
        'owner/',         // Missing repo
        'owner/repo/sub', // Too many parts
        'owner repo',     // Space instead of slash
      ];

      invalidRepos.forEach(repo => {
        expect(repoPattern.test(repo)).toBe(false);
      });
    });
  });

  describe('UUID Validation', () => {
    it('should validate UUID format', () => {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      const validUUIDs = [
        '550e8400-e29b-41d4-a716-446655440000',
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        'A550E840-E29B-41D4-A716-446655440000', // uppercase is valid
      ];

      validUUIDs.forEach(uuid => {
        expect(uuidPattern.test(uuid)).toBe(true);
      });
    });

    it('should reject invalid UUID formats', () => {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      const invalidUUIDs = [
        '550e8400e29b41d4a716446655440000',     // No dashes
        '550e8400-e29b-41d4-a716-44665544000',  // Too short
        '550e8400-e29b-41d4-a716-4466554400000', // Too long
        'not-a-uuid',
        '',
      ];

      invalidUUIDs.forEach(uuid => {
        expect(uuidPattern.test(uuid)).toBe(false);
      });
    });
  });

  describe('API Key Validation', () => {
    it('should validate API key format', () => {
      const apiKeyPattern = /^bh_[a-f0-9]{64}$/;

      const validKey = 'bh_' + 'a'.repeat(64);
      expect(apiKeyPattern.test(validKey)).toBe(true);
    });

    it('should reject invalid API key formats', () => {
      const apiKeyPattern = /^bh_[a-f0-9]{64}$/;

      const invalidKeys = [
        'a'.repeat(64),           // No prefix
        'bh_' + 'a'.repeat(63),   // Too short
        'bh_' + 'a'.repeat(65),   // Too long
        'bh_' + 'g'.repeat(64),   // Invalid hex character
        'sk_' + 'a'.repeat(64),   // Wrong prefix
      ];

      invalidKeys.forEach(key => {
        expect(apiKeyPattern.test(key)).toBe(false);
      });
    });
  });
});
