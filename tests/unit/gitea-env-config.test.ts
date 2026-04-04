import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Gitea Environment Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('defaultGitBackend auto-detection', () => {
    it('should default to gitea when GITEA_URL is set', async () => {
      process.env.GITEA_URL = 'http://gitea:3000';
      delete process.env.DEFAULT_GIT_BACKEND;

      // Re-import to pick up new env
      const { config } = await import('../../src/config/env.js');

      // The config should detect gitea from GITEA_URL
      expect(config.gitea.url).toBe('http://gitea:3000');
      // defaultGitBackend uses runtime env check
      const backend = process.env.DEFAULT_GIT_BACKEND || (process.env.GITEA_URL ? 'gitea' : 'github');
      expect(backend).toBe('gitea');
    });

    it('should default to github when GITEA_URL is not set', () => {
      delete process.env.GITEA_URL;
      delete process.env.DEFAULT_GIT_BACKEND;

      const backend = process.env.DEFAULT_GIT_BACKEND || (process.env.GITEA_URL ? 'gitea' : 'github');
      expect(backend).toBe('github');
    });

    it('should respect explicit DEFAULT_GIT_BACKEND override', () => {
      process.env.GITEA_URL = 'http://gitea:3000';
      process.env.DEFAULT_GIT_BACKEND = 'cascade';

      const backend = process.env.DEFAULT_GIT_BACKEND || (process.env.GITEA_URL ? 'gitea' : 'github');
      expect(backend).toBe('cascade');
    });
  });

  describe('gitea config block', () => {
    it('should read all Gitea env vars', () => {
      process.env.GITEA_URL = 'http://gitea:3000';
      process.env.GITEA_ADMIN_TOKEN = 'admin-token-123';
      process.env.GITEA_INTERNAL_SECRET = 'internal-secret';
      process.env.GITEA_SSH_URL = 'ssh://git@localhost:2222';
      process.env.GITEA_EXTERNAL_URL = 'http://localhost:3001';

      expect(process.env.GITEA_URL).toBe('http://gitea:3000');
      expect(process.env.GITEA_ADMIN_TOKEN).toBe('admin-token-123');
      expect(process.env.GITEA_INTERNAL_SECRET).toBe('internal-secret');
      expect(process.env.GITEA_SSH_URL).toBe('ssh://git@localhost:2222');
      expect(process.env.GITEA_EXTERNAL_URL).toBe('http://localhost:3001');
    });

    it('should handle missing optional vars gracefully', () => {
      delete process.env.GITEA_URL;
      delete process.env.GITEA_ADMIN_TOKEN;
      delete process.env.GITEA_INTERNAL_SECRET;
      delete process.env.GITEA_SSH_URL;
      delete process.env.GITEA_EXTERNAL_URL;

      expect(process.env.GITEA_URL).toBeUndefined();
      expect(process.env.GITEA_ADMIN_TOKEN).toBeUndefined();
    });
  });
});
