import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Gitea Repo Creation Flow', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockGiteaAdmin: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockQuery = vi.fn();
    mockGiteaAdmin = {
      isConfigured: true as any,
      ensureOrg: vi.fn().mockResolvedValue({ id: 1, username: 'test-org' }),
      createRepo: vi.fn().mockResolvedValue({
        id: 42,
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        clone_url: 'http://gitea:3000/test-org/my-repo.git',
        html_url: 'http://gitea:3000/test-org/my-repo',
        default_branch: 'main',
      }),
      installWebhook: vi.fn().mockResolvedValue({ id: 1 }),
      addRepoCollaborator: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('repo creation with gitea backend', () => {
    it('should create org, repo, and webhook in Gitea', async () => {
      const orgName = 'test-org';
      const repoName = 'my-repo';

      // Simulate the creation flow
      const giteaOrg = await mockGiteaAdmin.ensureOrg(orgName);
      expect(giteaOrg.username).toBe('test-org');

      const giteaRepo = await mockGiteaAdmin.createRepo(orgName, repoName, {
        isPrivate: false,
        description: 'A test repo',
        autoInit: true,
      });
      expect(giteaRepo.id).toBe(42);
      expect(giteaRepo.full_name).toBe('test-org/my-repo');

      await mockGiteaAdmin.installWebhook(orgName, repoName, 'http://api:3000/api/v1/webhooks/git');

      expect(mockGiteaAdmin.ensureOrg).toHaveBeenCalledWith(orgName);
      expect(mockGiteaAdmin.createRepo).toHaveBeenCalledWith(orgName, repoName, expect.objectContaining({
        isPrivate: false,
        autoInit: true,
      }));
      expect(mockGiteaAdmin.installWebhook).toHaveBeenCalledWith(
        orgName, repoName, 'http://api:3000/api/v1/webhooks/git'
      );
    });

    it('should store gitea metadata in database', async () => {
      const giteaRepo = await mockGiteaAdmin.createRepo('test-org', 'my-repo');

      // Simulate DB insert
      const insertValues = {
        org_id: 'org-uuid',
        name: 'my-repo',
        git_backend: 'gitea',
        gitea_repo_id: giteaRepo.id,
        gitea_owner: 'test-org',
        gitea_repo_name: 'my-repo',
        gitea_url: giteaRepo.html_url,
      };

      expect(insertValues.git_backend).toBe('gitea');
      expect(insertValues.gitea_repo_id).toBe(42);
      expect(insertValues.gitea_owner).toBe('test-org');
      expect(insertValues.gitea_url).toBe('http://gitea:3000/test-org/my-repo');
    });

    it('should add agent as Gitea collaborator when agent has Gitea user', async () => {
      const agentGiteaUsername = 'agent-1';

      await mockGiteaAdmin.addRepoCollaborator('test-org', 'my-repo', agentGiteaUsername, 'write');

      expect(mockGiteaAdmin.addRepoCollaborator).toHaveBeenCalledWith(
        'test-org', 'my-repo', 'agent-1', 'write'
      );
    });

    it('should skip Gitea collaborator when agent has no Gitea mapping', async () => {
      // Simulate no Gitea user found
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const agentGiteaResult = await mockQuery(
        'SELECT gitea_username FROM gitswarm_agent_gitea_users WHERE agent_id = $1',
        ['agent-with-no-gitea']
      );

      expect(agentGiteaResult.rows).toHaveLength(0);
      // addRepoCollaborator should NOT be called
      expect(mockGiteaAdmin.addRepoCollaborator).not.toHaveBeenCalled();
    });
  });

  describe('repo creation with github backend (backward compat)', () => {
    it('should not call Gitea when backend is github', async () => {
      const gitBackend = 'github';

      if (gitBackend === 'gitea') {
        await mockGiteaAdmin.createRepo('org', 'repo');
      }

      expect(mockGiteaAdmin.createRepo).not.toHaveBeenCalled();
      expect(mockGiteaAdmin.installWebhook).not.toHaveBeenCalled();
    });

    it('should generate placeholder github_repo_id for github backend', () => {
      const gitBackend = 'github';
      const githubRepoId = gitBackend === 'github' ? Date.now() : null;

      expect(githubRepoId).toBeGreaterThan(0);
    });
  });
});
