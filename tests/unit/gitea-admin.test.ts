import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

describe('GiteaAdmin', () => {
  let GiteaAdmin: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set env before importing
    process.env.GITEA_URL = 'http://gitea:3000';
    process.env.GITEA_ADMIN_TOKEN = 'test-admin-token';
    process.env.GITEA_INTERNAL_SECRET = 'test-internal-secret';

    // Dynamic import to pick up env
    const mod = await import('../../src/services/gitea-admin.js');
    GiteaAdmin = mod.GiteaAdmin;
  });

  afterEach(() => {
    delete process.env.GITEA_URL;
    delete process.env.GITEA_ADMIN_TOKEN;
    delete process.env.GITEA_INTERNAL_SECRET;
  });

  function mockFetchResponse(status: number, body: any) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  describe('isConfigured', () => {
    it('should return true when baseUrl and adminToken are set', () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'token',
      });
      expect(admin.isConfigured).toBe(true);
    });

    it('should return false when baseUrl is missing', () => {
      const admin = new GiteaAdmin({
        baseUrl: '',
        adminToken: 'token',
      });
      expect(admin.isConfigured).toBe(false);
    });

    it('should return false when adminToken is missing', () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: '',
      });
      expect(admin.isConfigured).toBe(false);
    });
  });

  describe('createOrg', () => {
    it('should POST to /api/v1/orgs with correct payload', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, { id: 1, username: 'my-org', full_name: 'My Org' });

      const result = await admin.createOrg('my-org', 'My Org');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://gitea:3000/api/v1/orgs',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'token test-token',
          }),
          body: JSON.stringify({
            username: 'my-org',
            full_name: 'My Org',
            visibility: 'private',
          }),
        })
      );

      expect(result.id).toBe(1);
      expect(result.username).toBe('my-org');
    });
  });

  describe('getOrg', () => {
    it('should return org when found', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(200, { id: 1, username: 'my-org' });

      const result = await admin.getOrg('my-org');
      expect(result).not.toBeNull();
      expect(result!.username).toBe('my-org');
    });

    it('should return null when org not found', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });

      const result = await admin.getOrg('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('ensureOrg', () => {
    it('should return existing org without creating', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(200, { id: 1, username: 'existing-org' });

      const result = await admin.ensureOrg('existing-org');
      expect(result.username).toBe('existing-org');
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only the GET, no POST
    });

    it('should create org when it does not exist', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      // getOrg returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });
      // createOrg succeeds
      mockFetchResponse(201, { id: 2, username: 'new-org', full_name: 'new-org' });

      const result = await admin.ensureOrg('new-org');
      expect(result.username).toBe('new-org');
      expect(mockFetch).toHaveBeenCalledTimes(2); // GET + POST
    });
  });

  describe('createRepo', () => {
    it('should POST to /api/v1/orgs/:org/repos', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, {
        id: 42,
        name: 'my-repo',
        full_name: 'my-org/my-repo',
        clone_url: 'http://gitea:3000/my-org/my-repo.git',
        ssh_url: 'git@gitea:my-org/my-repo.git',
        html_url: 'http://gitea:3000/my-org/my-repo',
        default_branch: 'main',
        private: false,
      });

      const result = await admin.createRepo('my-org', 'my-repo', {
        description: 'Test repo',
        isPrivate: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://gitea:3000/api/v1/orgs/my-org/repos',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"my-repo"'),
        })
      );
      expect(result.id).toBe(42);
      expect(result.full_name).toBe('my-org/my-repo');
    });
  });

  describe('createAgentUser', () => {
    it('should create user via admin API', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, { id: 10, login: 'test-agent', email: 'test-agent@gitswarm.local' });

      const result = await admin.createAgentUser('test-agent');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://gitea:3000/api/v1/admin/users',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"username":"test-agent"'),
        })
      );
      expect(result.id).toBe(10);
      expect(result.login).toBe('test-agent');
    });

    it('should sanitize special characters in agent names', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, { id: 11, login: 'agent-with-special', email: 'agent-with-special@gitswarm.local' });

      await admin.createAgentUser('Agent_With.Special!Chars');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.username).toBe('agent-with-special-chars');
    });
  });

  describe('createAgentToken', () => {
    it('should POST to /api/v1/users/:username/tokens', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, { id: 1, name: 'gitswarm-123', sha1: 'abc123tokenvalue' });

      const result = await admin.createAgentToken('test-agent');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://gitea:3000/api/v1/users/test-agent/tokens',
        expect.objectContaining({ method: 'POST' })
      );
      expect(result.sha1).toBe('abc123tokenvalue');
    });
  });

  describe('installWebhook', () => {
    it('should install webhook with correct events and secret', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
        internalSecret: 'webhook-secret',
      });

      mockFetchResponse(201, { id: 1, url: 'http://api:3000/webhooks/git', active: true });

      await admin.installWebhook('my-org', 'my-repo', 'http://api:3000/webhooks/git');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.config.url).toBe('http://api:3000/webhooks/git');
      expect(callBody.config.secret).toBe('webhook-secret');
      expect(callBody.events).toContain('push');
      expect(callBody.events).toContain('pull_request');
      expect(callBody.events).toContain('pull_request_review');
      expect(callBody.active).toBe(true);
    });
  });

  describe('buildCloneUrl', () => {
    it('should build authenticated clone URL with token', () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      const url = admin.buildCloneUrl('my-org', 'my-repo', 'agent-token-123');
      expect(url).toBe('http://x-access-token:agent-token-123@gitea:3000/my-org/my-repo.git');
    });

    it('should build unauthenticated clone URL without token', () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      const url = admin.buildCloneUrl('my-org', 'my-repo');
      expect(url).toBe('http://gitea:3000/my-org/my-repo.git');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('should verify valid HMAC-SHA256 signature', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
        internalSecret: 'my-secret',
      });

      const payload = '{"action":"push"}';
      const crypto = await import('crypto');
      const validSig = crypto
        .createHmac('sha256', 'my-secret')
        .update(payload)
        .digest('hex');

      expect(admin.verifyWebhookSignature(payload, validSig)).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
        internalSecret: 'my-secret',
      });

      const payload = '{"action":"push"}';
      const crypto = await import('crypto');
      const wrongSig = crypto
        .createHmac('sha256', 'wrong-secret')
        .update(payload)
        .digest('hex');

      expect(admin.verifyWebhookSignature(payload, wrongSig)).toBe(false);
    });

    it('should return false when no internal secret configured', () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
        internalSecret: '',
      });

      expect(admin.verifyWebhookSignature('payload', 'sig')).toBe(false);
    });
  });

  describe('mirrorFromGitHub', () => {
    it('should POST to /api/v1/repos/migrate with mirror flag', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetchResponse(201, {
        id: 99,
        name: 'mirrored-repo',
        full_name: 'my-org/mirrored-repo',
      });

      const result = await admin.mirrorFromGitHub(
        'https://github.com/source-org/source-repo',
        'my-org',
        'mirrored-repo',
        { githubToken: 'ghp_abc123', mirror: true }
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.clone_addr).toBe('https://github.com/source-org/source-repo');
      expect(callBody.auth_token).toBe('ghp_abc123');
      expect(callBody.mirror).toBe(true);
      expect(callBody.service).toBe('github');
      expect(result.id).toBe(99);
    });
  });

  describe('error handling', () => {
    it('should throw on non-2xx response', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve('{"message":"name already taken"}'),
      });

      await expect(admin.createOrg('duplicate-org')).rejects.toThrow('Gitea API POST /orgs failed (422)');
    });

    it('should handle 204 No Content responses', async () => {
      const admin = new GiteaAdmin({
        baseUrl: 'http://gitea:3000',
        adminToken: 'test-token',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
      });

      const result = await admin.deleteRepo('my-org', 'my-repo');
      expect(result).toBeUndefined();
    });
  });
});
