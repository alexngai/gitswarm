import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    gitea: { url: 'http://gitea:3000', adminToken: 'token', internalSecret: '', sshUrl: '', externalUrl: '' },
    defaultGitBackend: 'gitea',
  },
}));

vi.mock('../../src/middleware/authenticate.js', () => ({
  hashApiKey: vi.fn((key: string) => `hashed_${key}`),
  authenticate: vi.fn(),
  generateApiKey: vi.fn(),
}));

const mockCreateBranch = vi.fn().mockResolvedValue({});
const mockGetCloneAccess = vi.fn().mockResolvedValue({ cloneUrl: 'http://gitea/repo.git', token: 'tok' });

vi.mock('../../src/services/backend-factory.js', () => ({
  getBackendForRepo: vi.fn().mockResolvedValue({
    createBranch: (...args: any[]) => mockCreateBranch(...args),
    getCloneAccess: (...args: any[]) => mockGetCloneAccess(...args),
  }),
}));

vi.mock('../../src/services/gitswarm-permissions.js', () => ({
  GitSwarmPermissionService: vi.fn().mockImplementation(() => ({
    canPerform: vi.fn().mockResolvedValue({ allowed: true }),
    checkConsensus: vi.fn().mockResolvedValue({ reached: true, ratio: 1.0 }),
  })),
}));

// Mock map-events (prevent trying to emit to non-existent MAP server)
vi.mock('../../src/services/map-events.js', () => ({
  emitGitSwarmEvent: vi.fn(),
  GITSWARM_EVENTS: {
    STREAM_CREATED: 'gitswarm.stream.created',
    REVIEW_SUBMITTED: 'gitswarm.review.submitted',
    CONSENSUS_REACHED: 'gitswarm.consensus.reached',
    MERGE_COMPLETED: 'gitswarm.merge.completed',
    TASK_CLAIMED: 'gitswarm.task.claimed',
    SWARM_CREATED: 'gitswarm.swarm.created',
  },
  setMapServer: vi.fn(),
}));

// Mock map-server (for resolveGitSwarmAgentId)
vi.mock('../../src/services/map-server.js', () => ({
  resolveGitSwarmAgentId: vi.fn().mockReturnValue('agent-uuid-resolved'),
  createGitSwarmMAPServer: vi.fn(),
  initializeMAPServer: vi.fn(),
  createRepoScope: vi.fn(),
  setMapServer: vi.fn(),
}));

import { query, getClient } from '../../src/config/database.js';
import { emitGitSwarmEvent } from '../../src/services/map-events.js';
const mockQuery = vi.mocked(query);
const mockEmit = vi.mocked(emitGitSwarmEvent);

describe('MAP Extension Method Handlers', () => {
  let handlers: any;
  let mockCtx: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { createGitSwarmHandlers, setMapServerRef } = await import('../../src/services/map-handlers.js');

    // Set a mock MAP server ref so getAgentId works
    setMapServerRef({
      agents: {
        get: vi.fn().mockReturnValue({
          id: 'map-agent-id',
          metadata: { gitswarm_agent_id: 'agent-uuid-resolved' },
        }),
      },
    });

    handlers = createGitSwarmHandlers();

    mockCtx = {
      session: { agentIds: ['map-agent-id'] },
      requestId: 'req-1',
      signal: new AbortController().signal,
    };
  });

  // ============================================================
  // x-gitswarm/stream/create
  // ============================================================

  describe('x-gitswarm/stream/create', () => {
    it('should create a stream and return stream_id + stream_number', async () => {
      // Repo exists check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] } as any);
      // Permission check (via mock - GitSwarmPermissionService is mocked to return allowed)
      // INSERT stream
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-stream-id', stream_number: 1, branch: 'stream/feat-1', status: 'active' }],
      } as any);

      const result = await handlers['x-gitswarm/stream/create']({
        repo_id: 'repo-1',
        branch: 'stream/feat-1',
        base_branch: 'main',
        name: 'Add feature',
      }, mockCtx);

      expect(result.stream_id).toBe('new-stream-id');
      expect(result.stream_number).toBe(1);
      expect(result.branch).toBe('stream/feat-1');
      expect(result.status).toBe('active');

      // Verify event was emitted
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.stream.created',
        expect.objectContaining({ branch: 'stream/feat-1' }),
        'repo-1',
        'agent-uuid-resolved'
      );
    });

    it('should require repo_id and branch', async () => {
      await expect(
        handlers['x-gitswarm/stream/create']({ repo_id: 'r1' }, mockCtx)
      ).rejects.toThrow('repo_id and branch are required');

      await expect(
        handlers['x-gitswarm/stream/create']({ branch: 'b1' }, mockCtx)
      ).rejects.toThrow('repo_id and branch are required');
    });

    it('should attempt to create Gitea branch', async () => {
      // Repo check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] } as any);
      // INSERT stream
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'sid', stream_number: 2, branch: 'stream/new', status: 'active' }],
      } as any);

      await handlers['x-gitswarm/stream/create']({
        repo_id: 'repo-1', branch: 'stream/new', base_branch: 'buffer',
      }, mockCtx);

      expect(mockCreateBranch).toHaveBeenCalledWith('repo-1', 'stream/new', 'buffer');
    });
  });

  // ============================================================
  // x-gitswarm/stream/review
  // ============================================================

  describe('x-gitswarm/stream/review', () => {
    it('should insert review and return consensus state', async () => {
      // Get stream repo
      mockQuery.mockResolvedValueOnce({
        rows: [{ repo_id: 'repo-1', status: 'in_review' }],
      } as any);

      // INSERT review
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      // checkConsensusDetailed queries: repo config, reviews, maintainers
      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.66', min_reviews: '1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] } as any);

      const result = await handlers['x-gitswarm/stream/review']({
        stream_id: 'stream-1',
        verdict: 'approve',
        feedback: 'LGTM',
      }, mockCtx);

      expect(result.consensus).toBeDefined();
      expect(result.consensus.approvals).toBe(1);
      expect(result.consensus.threshold).toBe(0.66);
    });

    it('should move stream from active to in_review on first review', async () => {
      // Stream is active
      mockQuery.mockResolvedValueOnce({
        rows: [{ repo_id: 'repo-1', status: 'active' }],
      } as any);

      // INSERT review
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      // UPDATE status to in_review
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      // Consensus queries
      mockQuery.mockResolvedValueOnce({ rows: [{ consensus_threshold: '0.66', min_reviews: '1' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);

      await handlers['x-gitswarm/stream/review']({
        stream_id: 'stream-1', verdict: 'approve',
      }, mockCtx);

      // Third query should be the status update
      expect(mockQuery.mock.calls[2][0]).toContain("status = 'in_review'");
    });

    it('should reject invalid verdict', async () => {
      await expect(
        handlers['x-gitswarm/stream/review']({
          stream_id: 's1', verdict: 'invalid',
        }, mockCtx)
      ).rejects.toThrow('verdict must be');
    });

    it('should emit consensus.reached event when consensus is met', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ repo_id: 'repo-1', status: 'in_review' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      // Consensus returns reached=true
      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.5', min_reviews: '1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);

      await handlers['x-gitswarm/stream/review']({
        stream_id: 's1', verdict: 'approve',
      }, mockCtx);

      // Should emit both review.submitted and consensus.reached
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.review.submitted',
        expect.any(Object), 'repo-1', 'agent-uuid-resolved'
      );
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.consensus.reached',
        expect.objectContaining({ stream_id: 's1', reached: true }),
        'repo-1'
      );
    });
  });

  // ============================================================
  // x-gitswarm/stream/merge
  // ============================================================

  describe('x-gitswarm/stream/merge', () => {
    it('should return merged=false when consensus not reached', async () => {
      // Get stream
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', repo_id: 'repo-1', status: 'in_review', branch: 'stream/feat' }],
      } as any);

      // Consensus check: not reached
      mockQuery.mockResolvedValueOnce({ rows: [{ consensus_threshold: '0.66', min_reviews: '2' }] } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any);

      const result = await handlers['x-gitswarm/stream/merge']({
        stream_id: 's1',
      }, mockCtx);

      expect(result.merged).toBe(false);
      expect(result.reason).toBe('Consensus not reached');
      expect(result.consensus.reached).toBe(false);
    });

    it('should execute merge when consensus is reached', async () => {
      // Get stream
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', repo_id: 'repo-1', status: 'in_review', branch: 'stream/feat' }],
      } as any);

      // Consensus: reached
      mockQuery.mockResolvedValueOnce({ rows: [{ consensus_threshold: '0.5', min_reviews: '1' }] } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);

      // Get repo buffer_branch
      mockQuery.mockResolvedValueOnce({ rows: [{ buffer_branch: 'buffer' }] } as any);

      // Transaction mock
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // INSERT pending_merges
          .mockResolvedValueOnce({}) // INSERT gitswarm_merges
          .mockResolvedValueOnce({ rows: [{ id: 's1', status: 'merged' }] }) // UPDATE stream
          .mockResolvedValueOnce({}), // COMMIT
        release: vi.fn(),
      };
      vi.mocked(getClient).mockResolvedValueOnce(mockClient as any);

      const result = await handlers['x-gitswarm/stream/merge']({ stream_id: 's1' }, mockCtx);

      expect(result.merged).toBe(true);
      expect(result.target_branch).toBe('buffer');
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.merge.completed',
        expect.objectContaining({ stream_id: 's1', target_branch: 'buffer' }),
        'repo-1',
        'agent-uuid-resolved'
      );
    });

    it('should reject merge of already-merged stream', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', repo_id: 'r1', status: 'merged', branch: 'b' }],
      } as any);

      await expect(
        handlers['x-gitswarm/stream/merge']({ stream_id: 's1' }, mockCtx)
      ).rejects.toThrow('already merged');
    });

    it('should reject merge of abandoned stream', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', repo_id: 'r1', status: 'abandoned', branch: 'b' }],
      } as any);

      await expect(
        handlers['x-gitswarm/stream/merge']({ stream_id: 's1' }, mockCtx)
      ).rejects.toThrow('abandoned');
    });
  });

  // ============================================================
  // x-gitswarm/consensus/check
  // ============================================================

  describe('x-gitswarm/consensus/check', () => {
    it('should return detailed consensus state', async () => {
      // Get stream repo
      mockQuery.mockResolvedValueOnce({ rows: [{ repo_id: 'repo-1' }] } as any);

      // Consensus queries
      mockQuery.mockResolvedValueOnce({ rows: [{ consensus_threshold: '0.66', min_reviews: '1' }] } as any);
      mockQuery.mockResolvedValueOnce({
        rows: [
          { reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'agent-1' },
          { reviewer_id: 'r2', verdict: 'request_changes', reviewed_at: '2026-01-02', reviewer_name: 'agent-2' },
        ],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any);

      const result = await handlers['x-gitswarm/consensus/check']({
        stream_id: 'stream-1',
      }, mockCtx);

      expect(result.threshold).toBe(0.66);
      expect(result.approvals).toBe(1);
      expect(result.rejections).toBe(1);
      expect(result.total_maintainers).toBe(3);
      expect(result.votes).toHaveLength(2);
      expect(result.votes[0].reviewer_name).toBe('agent-1');
    });

    it('should throw for non-existent stream', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await expect(
        handlers['x-gitswarm/consensus/check']({ stream_id: 'bad' }, mockCtx)
      ).rejects.toThrow('Stream not found');
    });
  });

  // ============================================================
  // x-gitswarm/task/claim
  // ============================================================

  describe('x-gitswarm/task/claim', () => {
    it('should claim an open task', async () => {
      // INSERT claim
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'claim-1', task_id: 'task-1', agent_id: 'agent-uuid-resolved' }],
      } as any);

      // UPDATE task status
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      // SELECT task
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'task-1', repo_id: 'repo-1', title: 'Fix bug', status: 'claimed' }],
      } as any);

      const result = await handlers['x-gitswarm/task/claim']({ task_id: 'task-1' }, mockCtx);

      expect(result.claimed).toBe(true);
      expect(result.task.title).toBe('Fix bug');
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.task.claimed',
        expect.objectContaining({ task_id: 'task-1' }),
        'repo-1',
        'agent-uuid-resolved'
      );
    });

    it('should throw when task is not available', async () => {
      // INSERT returns no rows (WHERE clause failed — task not open)
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await expect(
        handlers['x-gitswarm/task/claim']({ task_id: 'claimed-task' }, mockCtx)
      ).rejects.toThrow('not available for claiming');
    });
  });

  // ============================================================
  // x-gitswarm/swarm/setup
  // ============================================================

  describe('x-gitswarm/swarm/setup', () => {
    it('should batch-create streams with dependency ordering', async () => {
      const streams = [
        { agent_id: 'a1', branch: 'stream/backend', base_branch: 'buffer', depends_on: [] },
        { agent_id: 'a2', branch: 'stream/api', base_branch: 'buffer', depends_on: ['stream/backend'] },
      ];

      // Repo check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] } as any);

      // Transaction mock
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({}) // BEGIN
          // INSERT stream 1
          .mockResolvedValueOnce({
            rows: [{ id: 'sid-1', stream_number: 1, branch: 'stream/backend', agent_id: 'a1', status: 'active' }],
          })
          // INSERT stream 2
          .mockResolvedValueOnce({
            rows: [{ id: 'sid-2', stream_number: 2, branch: 'stream/api', agent_id: 'a2', status: 'active' }],
          })
          // UPDATE parent_stream_id
          .mockResolvedValueOnce({ rows: [] })
          // COMMIT
          .mockResolvedValueOnce({}),
        release: vi.fn(),
      };
      vi.mocked(getClient).mockResolvedValueOnce(mockClient as any);

      const result = await handlers['x-gitswarm/swarm/setup']({
        repo_id: 'repo-1',
        task_id: 'task-1',
        streams,
      }, mockCtx);

      expect(result.streams).toHaveLength(2);
      expect(result.streams[0].branch).toBe('stream/backend');
      expect(result.streams[1].branch).toBe('stream/api');
      expect(result.clone_url).toBeDefined();

      // Verify branches were created
      expect(mockCreateBranch).toHaveBeenCalledTimes(2);
      expect(mockCreateBranch).toHaveBeenCalledWith('repo-1', 'stream/backend', 'buffer');
      expect(mockCreateBranch).toHaveBeenCalledWith('repo-1', 'stream/api', 'buffer');

      // Verify dependency was set via transaction client
      const parentCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('parent_stream_id')
      );
      expect(parentCall).toBeTruthy();
      expect(parentCall![1]).toHaveLength(2);

      // Verify event was emitted
      expect(mockEmit).toHaveBeenCalledWith(
        'gitswarm.swarm.created',
        expect.objectContaining({ stream_count: 2 }),
        'repo-1',
        'agent-uuid-resolved'
      );
    });

    it('should require repo_id and streams array', async () => {
      await expect(
        handlers['x-gitswarm/swarm/setup']({ repo_id: 'r1' }, mockCtx)
      ).rejects.toThrow('repo_id and streams array are required');

      await expect(
        handlers['x-gitswarm/swarm/setup']({ streams: [] }, mockCtx)
      ).rejects.toThrow('repo_id and streams array are required');
    });
  });

  // ============================================================
  // Agent identity resolution
  // ============================================================

  describe('Agent identity from MAP context', () => {
    it('should throw when no agent registered on session', async () => {
      const emptyCtx = {
        session: { agentIds: [] },
        requestId: 'req-1',
        signal: new AbortController().signal,
      };

      // stream/create requires agent identity (calls getAgentId)
      await expect(
        handlers['x-gitswarm/stream/create']({
          repo_id: 'r1', branch: 'stream/test',
        }, emptyCtx)
      ).rejects.toThrow('No agent registered');
    });
  });
});
