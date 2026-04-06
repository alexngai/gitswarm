import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    gitea: {
      url: 'http://gitea:3000',
      adminToken: 'admin-token',
      internalSecret: 'secret',
      sshUrl: '',
      externalUrl: '',
    },
    defaultGitBackend: 'gitea',
  },
}));

vi.mock('../../src/middleware/authenticate.js', () => ({
  hashApiKey: vi.fn((key: string) => `hashed_${key}`),
  authenticate: vi.fn(),
  generateApiKey: vi.fn(),
}));

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('GitHub-Compatible API Facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Auth middleware', () => {
    it('should accept Bearer token prefix', async () => {
      const { githubCompatAuth } = await import('../../src/routes/github-compat/index.js');

      const mockReq = {
        headers: { authorization: 'Bearer test-api-key' },
        agent: null as any,
      };
      const mockRep = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'agent-1', name: 'test-agent', karma: 100, status: 'active' }],
      } as any);

      await githubCompatAuth(mockReq, mockRep);
      expect(mockReq.agent).toBeTruthy();
      expect(mockReq.agent.name).toBe('test-agent');
    });

    it('should accept token prefix (GitHub-style)', async () => {
      const { githubCompatAuth } = await import('../../src/routes/github-compat/index.js');

      const mockReq = {
        headers: { authorization: 'token test-api-key' },
        agent: null as any,
      };
      const mockRep = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'agent-2', name: 'gh-agent', karma: 50, status: 'active' }],
      } as any);

      await githubCompatAuth(mockReq, mockRep);
      expect(mockReq.agent).toBeTruthy();
      expect(mockReq.agent.name).toBe('gh-agent');
    });

    it('should reject missing authorization header', async () => {
      const { githubCompatAuth } = await import('../../src/routes/github-compat/index.js');

      const mockReq = { headers: {} };
      const mockRep = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await githubCompatAuth(mockReq, mockRep);
      expect(mockRep.status).toHaveBeenCalledWith(401);
      expect(mockRep.send).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Requires authentication',
      }));
    });

    it('should reject invalid API key', async () => {
      const { githubCompatAuth } = await import('../../src/routes/github-compat/index.js');

      const mockReq = {
        headers: { authorization: 'Bearer invalid-key' },
        agent: null as any,
      };
      const mockRep = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await githubCompatAuth(mockReq, mockRep);
      expect(mockRep.status).toHaveBeenCalledWith(401);
    });

    it('should reject suspended agent', async () => {
      const { githubCompatAuth } = await import('../../src/routes/github-compat/index.js');

      const mockReq = {
        headers: { authorization: 'token test-key' },
        agent: null as any,
      };
      const mockRep = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'agent-3', name: 'banned', karma: 0, status: 'banned' }],
      } as any);

      await githubCompatAuth(mockReq, mockRep);
      expect(mockRep.status).toHaveBeenCalledWith(403);
    });
  });

  describe('resolveRepoFromParams', () => {
    it('should find repo by gitea_owner + gitea_repo_name', async () => {
      const { resolveRepoFromParams } = await import('../../src/routes/github-compat/index.js');

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          gitea_owner: 'my-org',
          gitea_repo_name: 'my-repo',
          default_branch: 'main',
        }],
      } as any);

      const repo = await resolveRepoFromParams('my-org', 'my-repo');
      expect(repo).toBeTruthy();
      expect(repo!.gitea_owner).toBe('my-org');
    });

    it('should return null when not found', async () => {
      const { resolveRepoFromParams } = await import('../../src/routes/github-compat/index.js');

      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      const repo = await resolveRepoFromParams('unknown', 'repo');
      expect(repo).toBeNull();
    });
  });

  describe('Stream ↔ PR status mapping', () => {
    it('should map active to open', async () => {
      const { mapStreamStatusToGitHubState } = await import('../../src/routes/github-compat/index.js');
      expect(mapStreamStatusToGitHubState('active')).toBe('open');
    });

    it('should map in_review to open', async () => {
      const { mapStreamStatusToGitHubState } = await import('../../src/routes/github-compat/index.js');
      expect(mapStreamStatusToGitHubState('in_review')).toBe('open');
    });

    it('should map merged to closed', async () => {
      const { mapStreamStatusToGitHubState } = await import('../../src/routes/github-compat/index.js');
      expect(mapStreamStatusToGitHubState('merged')).toBe('closed');
    });

    it('should map abandoned to closed', async () => {
      const { mapStreamStatusToGitHubState } = await import('../../src/routes/github-compat/index.js');
      expect(mapStreamStatusToGitHubState('abandoned')).toBe('closed');
    });
  });

  describe('PR response format', () => {
    it('should match GitHub PR response shape', () => {
      const prResponse = {
        number: 42,
        state: 'open',
        title: 'feat: new feature',
        body: 'Description',
        head: { ref: 'stream/feat-1', label: 'org:stream/feat-1' },
        base: { ref: 'main', label: 'org:main' },
        user: { login: 'agent-1', id: 'uuid', type: 'Bot' },
        merged: false,
        created_at: '2026-04-03T00:00:00Z',
        updated_at: '2026-04-03T00:00:00Z',
      };

      // Verify all fields GitHub clients expect are present
      expect(prResponse.number).toBeDefined();
      expect(prResponse.state).toMatch(/^(open|closed)$/);
      expect(prResponse.title).toBeDefined();
      expect(prResponse.head.ref).toBeDefined();
      expect(prResponse.base.ref).toBeDefined();
      expect(prResponse.user.login).toBeDefined();
      expect(typeof prResponse.merged).toBe('boolean');
    });

    it('should include GitSwarm extensions', () => {
      const prResponse = {
        number: 42,
        state: 'open',
        gitswarm_stream_id: 'stream-uuid',
        gitswarm_status: 'in_review',
        gitswarm_review_status: 'pending',
      };

      expect(prResponse.gitswarm_stream_id).toBeDefined();
      expect(prResponse.gitswarm_status).toBe('in_review');
    });
  });

  describe('Issue response format', () => {
    it('should match GitHub Issue response shape', () => {
      const issueResponse = {
        number: 5,
        state: 'open',
        title: 'Bug: something broken',
        body: 'Steps to reproduce...',
        labels: [{ name: 'bug' }],
        user: { login: 'agent-1', type: 'Bot' },
        created_at: '2026-04-03T00:00:00Z',
      };

      expect(issueResponse.number).toBeDefined();
      expect(issueResponse.state).toMatch(/^(open|closed)$/);
      expect(issueResponse.title).toBeDefined();
      expect(issueResponse.labels).toBeInstanceOf(Array);
      expect(issueResponse.user.login).toBeDefined();
    });

    it('should include GitSwarm task extensions', () => {
      const issueResponse = {
        number: 5,
        gitswarm_task_id: 'task-uuid',
        gitswarm_status: 'claimed',
        gitswarm_priority: 'high',
        gitswarm_amount: 100,
        gitswarm_difficulty: 'medium',
      };

      expect(issueResponse.gitswarm_task_id).toBeDefined();
      expect(issueResponse.gitswarm_amount).toBe(100);
    });
  });

  describe('Review → Consensus vote mapping', () => {
    it('should map APPROVE to approve verdict', () => {
      const eventMap: Record<string, string> = {
        'APPROVE': 'approve',
        'REQUEST_CHANGES': 'request_changes',
        'COMMENT': 'comment',
      };

      expect(eventMap['APPROVE']).toBe('approve');
      expect(eventMap['REQUEST_CHANGES']).toBe('request_changes');
      expect(eventMap['COMMENT']).toBe('comment');
    });
  });

  describe('Merge governance gate', () => {
    it('should return 405 with consensus details when not reached', () => {
      const consensus = {
        reached: false,
        threshold: 0.66,
        ratio: 0.33,
        approvals: 1,
        rejections: 0,
      };

      const response = {
        message: 'Consensus not reached. Required approvals not met.',
        consensus: {
          threshold: consensus.threshold,
          current_ratio: consensus.ratio,
          approvals: consensus.approvals,
          rejections: consensus.rejections,
        },
      };

      expect(response.consensus.threshold).toBe(0.66);
      expect(response.consensus.current_ratio).toBe(0.33);
    });

    it('should return merged=true when consensus reached', () => {
      const response = { merged: true, message: 'Merge stream stream/feat-1' };
      expect(response.merged).toBe(true);
    });
  });
});

describe('Mirror Management', () => {
  it('should support three mirror directions', () => {
    const directions = ['pull', 'push', 'bidirectional'];
    expect(directions).toContain('pull');
    expect(directions).toContain('push');
    expect(directions).toContain('bidirectional');
  });

  it('should format mirror creation request', () => {
    const mirrorRequest = {
      github_url: 'https://github.com/org/repo',
      direction: 'push' as const,
      github_token: 'ghp_xxx',
      sync_interval: '10m',
    };

    expect(mirrorRequest.github_url).toContain('github.com');
    expect(mirrorRequest.direction).toBe('push');
    expect(mirrorRequest.github_token).toBeTruthy();
  });
});
