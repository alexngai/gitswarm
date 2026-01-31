import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
global.fetch = vi.fn();

describe('GitHub Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GitHubApp', () => {
    it('should throw error when app is not configured', async () => {
      // Dynamically import after clearing env
      const originalAppId = process.env.GITHUB_APP_ID;
      const originalPrivateKey = process.env.GITHUB_PRIVATE_KEY;

      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_PRIVATE_KEY;

      const { GitHubApp } = await import('../../src/services/github.js');
      const app = new GitHubApp();

      expect(() => app.generateJWT()).toThrow('GitHub App not configured');

      // Restore
      if (originalAppId) process.env.GITHUB_APP_ID = originalAppId;
      if (originalPrivateKey) process.env.GITHUB_PRIVATE_KEY = originalPrivateKey;
    });

    it('should verify webhook signature correctly', async () => {
      const { GitHubApp } = await import('../../src/services/github.js');

      // Create app with a known secret
      const app = new GitHubApp();
      app.webhookSecret = 'test-secret';

      const payload = '{"action":"opened"}';

      // Generate expected signature
      const crypto = await import('crypto');
      const expectedSig = 'sha256=' + crypto
        .createHmac('sha256', 'test-secret')
        .update(payload)
        .digest('hex');

      expect(app.verifyWebhookSignature(payload, expectedSig)).toBe(true);
    });

    it('should reject invalid webhook signature', async () => {
      const { GitHubApp } = await import('../../src/services/github.js');

      const app = new GitHubApp();
      app.webhookSecret = 'test-secret';

      const payload = '{"action":"opened"}';
      // Use a signature of correct length but wrong content
      const crypto = await import('crypto');
      const wrongSig = 'sha256=' + crypto
        .createHmac('sha256', 'wrong-secret')
        .update(payload)
        .digest('hex');

      expect(app.verifyWebhookSignature(payload, wrongSig)).toBe(false);
    });

    it('should return false when webhook secret is not set', async () => {
      const { GitHubApp } = await import('../../src/services/github.js');

      const app = new GitHubApp();
      app.webhookSecret = null;

      expect(app.verifyWebhookSignature('payload', 'sig')).toBe(false);
    });
  });

  describe('GitHubRepo', () => {
    it('should make authenticated requests', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, name: 'test-repo' }),
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.getRepo();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
      expect(result.name).toBe('test-repo');
    });

    it('should throw error on API failure', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');

      await expect(repo.getRepo()).rejects.toThrow('GitHub API error: 404');
    });

    it('should handle 204 No Content responses', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.request('DELETE', '/test');

      expect(result).toBeNull();
    });

    it('should get default branch from repo info', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ default_branch: 'main' }),
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const branch = await repo.getDefaultBranch();

      expect(branch).toBe('main');
    });

    it('should create a branch from base', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      // Mock getDefaultBranch
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ default_branch: 'main' }),
        })
        // Mock getRef
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ object: { sha: 'abc123' } }),
        })
        // Mock createRef
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ ref: 'refs/heads/new-branch' }),
        });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.createBranch('new-branch');

      expect(result.ref).toBe('refs/heads/new-branch');
    });

    it('should return null for non-existent files', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ default_branch: 'main' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => 'Not Found',
        });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.getFileContent('nonexistent.txt');

      expect(result).toBeNull();
    });

    it('should create a pull request', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ default_branch: 'main' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
          }),
        });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const pr = await repo.createPullRequest('Test PR', 'Description', 'feature-branch');

      expect(pr.number).toBe(42);
      expect(pr.html_url).toContain('/pull/42');
    });

    it('should merge a pull request', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ merged: true }),
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.mergePullRequest(42, 'Merge commit');

      expect(result.merged).toBe(true);
    });

    it('should close a pull request', async () => {
      const { GitHubRepo } = await import('../../src/services/github.js');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'closed' }),
      });

      const repo = new GitHubRepo('test-token', 'owner', 'repo');
      const result = await repo.closePullRequest(42);

      expect(result.state).toBe('closed');
    });
  });

  describe('ForgeGitHubService', () => {
    it('should throw error when forge not found', async () => {
      const { ForgeGitHubService } = await import('../../src/services/github.js');

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const service = new ForgeGitHubService(mockDb);

      await expect(service.getRepoForForge('nonexistent')).rejects.toThrow('Forge not found');
    });

    it('should throw error when forge not linked to GitHub', async () => {
      const { ForgeGitHubService } = await import('../../src/services/github.js');

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ github_repo: null, github_app_installation_id: null }],
        }),
      };

      const service = new ForgeGitHubService(mockDb);

      await expect(service.getRepoForForge('forge-id')).rejects.toThrow('Forge not linked to GitHub');
    });

    it('should slugify titles correctly', async () => {
      const { ForgeGitHubService } = await import('../../src/services/github.js');

      const service = new ForgeGitHubService({});

      expect(service.slugify('Add New Feature!')).toBe('add-new-feature');
      expect(service.slugify('Fix Bug #123')).toBe('fix-bug-123');
      expect(service.slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
      expect(service.slugify('UPPERCASE')).toBe('uppercase');
      expect(service.slugify('Special@#$Characters')).toBe('special-characters');
    });

    it('should truncate long slugs', async () => {
      const { ForgeGitHubService } = await import('../../src/services/github.js');

      const service = new ForgeGitHubService({});
      const longTitle = 'This is a very long title that should be truncated to fifty characters maximum';
      const slug = service.slugify(longTitle);

      expect(slug.length).toBeLessThanOrEqual(50);
    });
  });
});
