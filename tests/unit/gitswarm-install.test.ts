import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies
const mockQuery = vi.fn();
const mockGithubApp = {
  getInstallationDetails: vi.fn(),
  getInstallationRepositories: vi.fn()
};

vi.mock('../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args)
}));

vi.mock('../../src/services/github.js', () => ({
  githubApp: mockGithubApp
}));

// Import after mocking
const { installRoutes } = await import('../../src/routes/gitswarm/install.js');

describe('GitSwarm Install Routes', () => {
  let app: any;
  let mockActivityService: { logActivity: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityService = {
      logActivity: vi.fn().mockResolvedValue(undefined)
    };

    app = {
      get: vi.fn(),
      post: vi.fn()
    };
  });

  describe('Route Registration', () => {
    it('should register all install routes', async () => {
      await installRoutes(app, { activityService: mockActivityService });

      // Check that routes are registered
      expect(app.get).toHaveBeenCalledWith('/gitswarm/install', expect.any(Function));
      expect(app.get).toHaveBeenCalledWith('/gitswarm/callback', expect.any(Function));
      expect(app.get).toHaveBeenCalledWith('/gitswarm/install/status/:orgName', expect.any(Function));
      expect(app.post).toHaveBeenCalledWith('/gitswarm/install/:orgId/sync', expect.any(Function));
    });
  });

  describe('GET /gitswarm/install', () => {
    let handler;

    beforeEach(async () => {
      await installRoutes(app, { activityService: mockActivityService });
      handler = app.get.mock.calls.find(c => c[0] === '/gitswarm/install')[1];
    });

    it('should redirect to GitHub App installation URL', async () => {
      const mockReply = { redirect: vi.fn() };

      await handler({ query: {} }, mockReply);

      expect(mockReply.redirect).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/apps/')
      );
    });

    it('should include state parameter when provided', async () => {
      const mockReply = { redirect: vi.fn() };

      await handler({ query: { state: 'my-state' } }, mockReply);

      expect(mockReply.redirect).toHaveBeenCalledWith(
        expect.stringContaining('state=my-state')
      );
    });

    it('should include suggested_target_id when provided', async () => {
      const mockReply = { redirect: vi.fn() };

      await handler({ query: { suggested_target_id: '12345' } }, mockReply);

      expect(mockReply.redirect).toHaveBeenCalledWith(
        expect.stringContaining('suggested_target_id=12345')
      );
    });

    it('should include both parameters when provided', async () => {
      const mockReply = { redirect: vi.fn() };

      await handler({
        query: { state: 'redirect-url', suggested_target_id: '12345' }
      }, mockReply);

      const redirectUrl = mockReply.redirect.mock.calls[0][0];
      expect(redirectUrl).toContain('state=redirect-url');
      expect(redirectUrl).toContain('suggested_target_id=12345');
    });
  });

  describe('GET /gitswarm/callback', () => {
    let handler;

    beforeEach(async () => {
      await installRoutes(app, { activityService: mockActivityService });
      handler = app.get.mock.calls.find(c => c[0] === '/gitswarm/callback')[1];
    });

    it('should return error for missing installation_id', async () => {
      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({ query: {} }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Bad Request',
        message: 'Missing installation_id parameter'
      });
    });

    it('should return error when installation not found on GitHub', async () => {
      mockGithubApp.getInstallationDetails.mockResolvedValueOnce(null);
      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({ query: { installation_id: '12345' } }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Not Found',
        message: 'Installation not found on GitHub'
      });
    });

    it('should create org and sync repos on successful installation', async () => {
      mockGithubApp.getInstallationDetails.mockResolvedValueOnce({
        account: {
          login: 'test-org',
          id: 12345,
          avatar_url: 'https://example.com/avatar.png',
          html_url: 'https://github.com/test-org',
          type: 'Organization'
        }
      });

      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([
        {
          name: 'repo1',
          id: 1001,
          full_name: 'test-org/repo1',
          private: false,
          description: 'Test repo 1',
          default_branch: 'main',
          language: 'JavaScript'
        }
      ]);

      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'org-1', github_org_name: 'test-org', is_platform_org: false }]
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // syncRepository

      const mockReply = { redirect: vi.fn() };

      await handler({
        query: { installation_id: '12345', setup_action: 'install' }
      }, mockReply);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_orgs'),
        expect.arrayContaining(['test-org', 12345, '12345'])
      );
      expect(mockReply.redirect).toHaveBeenCalledWith('/gitswarm/orgs/org-1');
    });

    it('should redirect to state URL when provided', async () => {
      mockGithubApp.getInstallationDetails.mockResolvedValueOnce({
        account: { login: 'test-org', id: 12345, type: 'Organization' }
      });
      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([]);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'org-1', github_org_name: 'test-org', is_platform_org: false }]
      });

      const mockReply = { redirect: vi.fn() };

      await handler({
        query: {
          installation_id: '12345',
          state: encodeURIComponent('/dashboard?installed=true')
        }
      }, mockReply);

      expect(mockReply.redirect).toHaveBeenCalledWith('/dashboard?installed=true');
    });

    it('should return JSON when redirect=false', async () => {
      mockGithubApp.getInstallationDetails.mockResolvedValueOnce({
        account: { login: 'test-org', id: 12345, type: 'Organization' }
      });
      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([
        { name: 'repo1', id: 1001, full_name: 'test-org/repo1' }
      ]);
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'org-1', github_org_name: 'test-org', is_platform_org: false }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await handler({
        query: { installation_id: '12345', redirect: 'false' }
      }, {});

      expect(result).toEqual({
        success: true,
        org: {
          id: 'org-1',
          github_org_name: 'test-org',
          is_platform_org: false
        },
        repos_synced: 1
      });
    });

    it('should log activity on successful installation', async () => {
      mockGithubApp.getInstallationDetails.mockResolvedValueOnce({
        account: { login: 'test-org', id: 12345, type: 'Organization' }
      });
      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([]);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'org-1', github_org_name: 'test-org', is_platform_org: false }]
      });

      await handler({
        query: { installation_id: '12345', setup_action: 'install', redirect: 'false' }
      }, {});

      expect(mockActivityService.logActivity).toHaveBeenCalledWith({
        event_type: 'gitswarm_org_installed',
        target_type: 'gitswarm_org',
        target_id: 'org-1',
        metadata: expect.objectContaining({
          org_name: 'test-org',
          setup_action: 'install'
        })
      });
    });

    it('should handle GitHub API errors', async () => {
      mockGithubApp.getInstallationDetails.mockRejectedValueOnce(
        new Error('GitHub API error')
      );

      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({
        query: { installation_id: '12345' }
      }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Installation Failed',
        message: 'Failed to complete GitHub App installation'
      });
    });
  });

  describe('GET /gitswarm/install/status/:orgName', () => {
    let handler;

    beforeEach(async () => {
      await installRoutes(app, { activityService: mockActivityService });
      handler = app.get.mock.calls.find(c => c[0] === '/gitswarm/install/status/:orgName')[1];
    });

    it('should return installed=false for non-existent org', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await handler(
        { params: { orgName: 'unknown-org' } },
        {}
      );

      expect(result).toEqual({
        installed: false,
        org_name: 'unknown-org'
      });
    });

    it('should return org details for installed org', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'org-1',
            github_org_name: 'test-org',
            github_installation_id: '12345',
            status: 'active',
            is_platform_org: false,
            default_agent_access: 'public',
            default_min_karma: 0,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            metadata: { avatar_url: 'https://example.com/avatar.png' }
          }]
        })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] });

      const result = await handler(
        { params: { orgName: 'test-org' } },
        {}
      );

      expect(result.installed).toBe(true);
      expect(result.org.github_org_name).toBe('test-org');
      expect(result.org.repo_count).toBe(5);
      expect(result.org.avatar_url).toBe('https://example.com/avatar.png');
    });
  });

  describe('POST /gitswarm/install/:orgId/sync', () => {
    let handler;

    beforeEach(async () => {
      await installRoutes(app, { activityService: mockActivityService });
      handler = app.post.mock.calls.find(c => c[0] === '/gitswarm/install/:orgId/sync')[1];
    });

    it('should return error for non-existent org', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({ params: { orgId: 'unknown' } }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Not Found',
        message: 'Organization not found'
      });
    });

    it('should return error for inactive org', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'org-1',
          github_org_name: 'test-org',
          github_installation_id: '12345',
          status: 'suspended'
        }]
      });
      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({ params: { orgId: 'org-1' } }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Bad Request',
        message: 'Organization is suspended, cannot sync'
      });
    });

    it('should sync repositories successfully', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'org-1',
          github_org_name: 'test-org',
          github_installation_id: '12345',
          status: 'active'
        }]
      });

      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([
        { name: 'repo1', id: 1001, full_name: 'test-org/repo1', private: false },
        { name: 'repo2', id: 1002, full_name: 'test-org/repo2', private: true }
      ]);

      // Mock syncRepository calls
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await handler({ params: { orgId: 'org-1' } }, {});

      expect(result).toEqual({
        success: true,
        synced: 2,
        failed: 0,
        total: 2
      });
    });

    it('should handle partial sync failures', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'org-1',
          github_org_name: 'test-org',
          github_installation_id: '12345',
          status: 'active'
        }]
      });

      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([
        { name: 'repo1', id: 1001, full_name: 'test-org/repo1' },
        { name: 'repo2', id: 1002, full_name: 'test-org/repo2' }
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await handler({ params: { orgId: 'org-1' } }, {});

      expect(result).toEqual({
        success: true,
        synced: 1,
        failed: 1,
        total: 2
      });
    });

    it('should handle GitHub API errors', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'org-1',
          github_org_name: 'test-org',
          github_installation_id: '12345',
          status: 'active'
        }]
      });

      mockGithubApp.getInstallationRepositories.mockRejectedValueOnce(
        new Error('GitHub API error')
      );

      const mockReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };

      await handler({ params: { orgId: 'org-1' } }, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Sync Failed',
        message: 'Failed to sync repositories from GitHub'
      });
    });

    it('should handle empty repository list', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'org-1',
          github_org_name: 'test-org',
          github_installation_id: '12345',
          status: 'active'
        }]
      });

      mockGithubApp.getInstallationRepositories.mockResolvedValueOnce([]);

      const result = await handler({ params: { orgId: 'org-1' } }, {});

      expect(result).toEqual({
        success: true,
        synced: 0,
        failed: 0,
        total: 0
      });
    });
  });
});
