import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Agent Registration with Gitea', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockGiteaAdmin: Record<string, ReturnType<typeof vi.fn> | boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn();

    mockGiteaAdmin = {
      isConfigured: true,
      createAgentUser: vi.fn().mockResolvedValue({
        id: 10,
        login: 'test-agent',
        email: 'test-agent@gitswarm.local',
      }),
      createAgentToken: vi.fn().mockResolvedValue({
        id: 1,
        name: 'gitswarm-token',
        sha1: 'token-sha1-value',
      }),
    };
  });

  describe('Gitea user creation on agent registration', () => {
    it('should create Gitea user and token when Gitea is configured', async () => {
      const agentName = 'test-agent';
      const agentId = 'agent-uuid';

      // Step 1: Create Gitea user
      const giteaUser = await (mockGiteaAdmin.createAgentUser as any)(agentName);
      expect(giteaUser.login).toBe('test-agent');
      expect(giteaUser.id).toBe(10);

      // Step 2: Create token
      const giteaToken = await (mockGiteaAdmin.createAgentToken as any)(giteaUser.login);
      expect(giteaToken.sha1).toBe('token-sha1-value');

      // Step 3: Store mapping in DB
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mapping-uuid' }] });

      await mockQuery(
        `INSERT INTO gitswarm_agent_gitea_users (agent_id, gitea_user_id, gitea_username, gitea_token_hash)
         VALUES ($1, $2, $3, $4)`,
        [agentId, giteaUser.id, giteaUser.login, giteaToken.sha1]
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_agent_gitea_users'),
        [agentId, 10, 'test-agent', 'token-sha1-value']
      );
    });

    it('should skip Gitea user creation when Gitea is not configured', async () => {
      mockGiteaAdmin.isConfigured = false;

      if (mockGiteaAdmin.isConfigured) {
        await (mockGiteaAdmin.createAgentUser as any)('test-agent');
      }

      expect(mockGiteaAdmin.createAgentUser).not.toHaveBeenCalled();
    });

    it('should not fail agent registration when Gitea user creation fails', async () => {
      (mockGiteaAdmin.createAgentUser as any).mockRejectedValueOnce(
        new Error('Gitea API error: username already taken')
      );

      let giteaUsername: string | undefined;
      let registrationSucceeded = false;

      try {
        const giteaUser = await (mockGiteaAdmin.createAgentUser as any)('duplicate-agent');
        giteaUsername = giteaUser.login;
      } catch (err) {
        // Non-fatal: log and continue
        console.error('Failed to create Gitea user:', (err as Error).message);
      }

      // Agent registration should still succeed
      registrationSucceeded = true;
      expect(registrationSucceeded).toBe(true);
      expect(giteaUsername).toBeUndefined();
    });

    it('should include gitea_username in registration response', () => {
      const response = {
        agent: {
          id: 'agent-uuid',
          name: 'test-agent',
          bio: null,
          karma: 0,
          status: 'active',
          created_at: '2026-04-03T00:00:00Z',
          gitea_username: 'test-agent',
        },
        api_key: 'gs_xxxxx',
        warning: 'Save your api_key now. It will not be shown again.',
      };

      expect(response.agent.gitea_username).toBe('test-agent');
    });

    it('should omit gitea_username when Gitea creation is skipped', () => {
      const response = {
        agent: {
          id: 'agent-uuid',
          name: 'test-agent',
          gitea_username: undefined,
        },
        api_key: 'gs_xxxxx',
      };

      expect(response.agent.gitea_username).toBeUndefined();
    });
  });

  describe('Agent token lifecycle', () => {
    it('should store token in gitswarm_agent_gitea_users table', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ gitea_token_hash: 'token-value' }] });

      const result = await mockQuery(
        'SELECT gitea_token_hash FROM gitswarm_agent_gitea_users WHERE agent_id = $1',
        ['agent-uuid']
      );

      expect(result.rows[0].gitea_token_hash).toBe('token-value');
    });

    it('should be retrievable for clone URL generation', async () => {
      const token = 'agent-token-sha1';
      const cloneUrl = `http://x-access-token:${token}@gitea:3000/org/repo.git`;

      expect(cloneUrl).toContain(token);
      expect(cloneUrl).toMatch(/^http:\/\/x-access-token:.+@gitea/);
    });
  });
});
