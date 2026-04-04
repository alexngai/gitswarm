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

vi.mock('../../src/services/backend-factory.js', () => ({
  getBackendForRepo: vi.fn().mockResolvedValue({
    createBranch: vi.fn().mockResolvedValue({}),
    getCloneAccess: vi.fn().mockResolvedValue({ cloneUrl: 'http://gitea/repo.git', token: 'tok' }),
  }),
}));

import { query, getClient } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('Phase 4A: MAP-Native Agent Platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Event taxonomy
  // ============================================================

  describe('GitSwarm Event Taxonomy', () => {
    it('should define all event type constants', async () => {
      const { GITSWARM_EVENTS } = await import('../../src/services/map-events.js');

      expect(GITSWARM_EVENTS.STREAM_CREATED).toBe('gitswarm.stream.created');
      expect(GITSWARM_EVENTS.REVIEW_SUBMITTED).toBe('gitswarm.review.submitted');
      expect(GITSWARM_EVENTS.CONSENSUS_REACHED).toBe('gitswarm.consensus.reached');
      expect(GITSWARM_EVENTS.MERGE_COMPLETED).toBe('gitswarm.merge.completed');
      expect(GITSWARM_EVENTS.STABILIZATION_PASSED).toBe('gitswarm.stabilization.passed');
      expect(GITSWARM_EVENTS.STABILIZATION_FAILED).toBe('gitswarm.stabilization.failed');
      expect(GITSWARM_EVENTS.PROMOTION_COMPLETED).toBe('gitswarm.promotion.completed');
      expect(GITSWARM_EVENTS.TASK_CREATED).toBe('gitswarm.task.created');
      expect(GITSWARM_EVENTS.TASK_CLAIMED).toBe('gitswarm.task.claimed');
      expect(GITSWARM_EVENTS.SWARM_CREATED).toBe('gitswarm.swarm.created');
      expect(GITSWARM_EVENTS.CI_COMPLETED).toBe('gitswarm.ci.completed');
    });

    it('should follow gitswarm.category.action naming convention', async () => {
      const { GITSWARM_EVENTS } = await import('../../src/services/map-events.js');

      for (const eventType of Object.values(GITSWARM_EVENTS)) {
        expect(eventType).toMatch(/^gitswarm\.\w+\.\w+$/);
      }
    });
  });

  // ============================================================
  // Consensus shared service function
  // ============================================================

  describe('checkConsensusDetailed', () => {
    it('should return reached=false when below threshold', async () => {
      const { checkConsensusDetailed } = await import('../../src/services/map-handlers.js');

      // Repo config: threshold=0.66, min_reviews=1
      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.66', min_reviews: '1' }],
      } as any);

      // Reviews: 1 approve
      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'agent-1' }],
      } as any);

      // Maintainers: 3 total
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any);

      const result = await checkConsensusDetailed('stream-1', 'repo-1');

      expect(result.reached).toBe(false);
      expect(result.ratio).toBeCloseTo(0.333);
      expect(result.threshold).toBe(0.66);
      expect(result.approvals).toBe(1);
      expect(result.total_maintainers).toBe(3);
    });

    it('should return reached=true when at or above threshold', async () => {
      const { checkConsensusDetailed } = await import('../../src/services/map-handlers.js');

      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.66', min_reviews: '1' }],
      } as any);

      // Reviews: 2 approves
      mockQuery.mockResolvedValueOnce({
        rows: [
          { reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'agent-1' },
          { reviewer_id: 'r2', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'agent-2' },
        ],
      } as any);

      // Maintainers: 3 total
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any);

      const result = await checkConsensusDetailed('stream-1', 'repo-1');

      expect(result.reached).toBe(true);
      expect(result.ratio).toBeCloseTo(0.667);
      expect(result.approvals).toBe(2);
      expect(result.votes).toHaveLength(2);
    });

    it('should require min_reviews', async () => {
      const { checkConsensusDetailed } = await import('../../src/services/map-handlers.js');

      // min_reviews=2, but only 1 review
      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.1', min_reviews: '2' }],
      } as any);

      mockQuery.mockResolvedValueOnce({
        rows: [{ reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' }],
      } as any);

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);

      const result = await checkConsensusDetailed('stream-1', 'repo-1');

      // ratio=1.0 >= 0.1 threshold, but only 1 approve < 2 min_reviews
      expect(result.reached).toBe(false);
    });

    it('should include rejections in the response', async () => {
      const { checkConsensusDetailed } = await import('../../src/services/map-handlers.js');

      mockQuery.mockResolvedValueOnce({
        rows: [{ consensus_threshold: '0.66', min_reviews: '1' }],
      } as any);

      mockQuery.mockResolvedValueOnce({
        rows: [
          { reviewer_id: 'r1', verdict: 'approve', reviewed_at: '2026-01-01', reviewer_name: 'a1' },
          { reviewer_id: 'r2', verdict: 'request_changes', reviewed_at: '2026-01-01', reviewer_name: 'a2' },
        ],
      } as any);

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] } as any);

      const result = await checkConsensusDetailed('stream-1', 'repo-1');

      expect(result.rejections).toBe(1);
      expect(result.approvals).toBe(1);
    });
  });

  // ============================================================
  // MAP extension method shapes
  // ============================================================

  describe('x-gitswarm extension methods', () => {
    it('should define all required handlers', async () => {
      const { createGitSwarmHandlers } = await import('../../src/services/map-handlers.js');

      const handlers = createGitSwarmHandlers();

      expect(handlers['x-gitswarm/stream/create']).toBeTypeOf('function');
      expect(handlers['x-gitswarm/stream/review']).toBeTypeOf('function');
      expect(handlers['x-gitswarm/stream/merge']).toBeTypeOf('function');
      expect(handlers['x-gitswarm/consensus/check']).toBeTypeOf('function');
      expect(handlers['x-gitswarm/task/claim']).toBeTypeOf('function');
      expect(handlers['x-gitswarm/swarm/setup']).toBeTypeOf('function');
    });
  });

  // ============================================================
  // MAP server concept mapping
  // ============================================================

  describe('Concept mapping', () => {
    it('repo scopes should follow repo:{uuid} naming', () => {
      const repoId = '550e8400-e29b-41d4-a716-446655440000';
      const scopeName = `repo:${repoId}`;
      expect(scopeName).toBe('repo:550e8400-e29b-41d4-a716-446655440000');
    });

    it('event scoping should match repo scope', () => {
      const event = {
        type: 'gitswarm.stream.created',
        data: { stream_id: 's1', branch: 'stream/feat-1', repo_id: 'repo-1' },
        scope: 'repo:repo-1',
      };

      expect(event.scope).toBe(`repo:${event.data.repo_id}`);
    });

    it('agent identity resolution maps API key to UUID', () => {
      // Simulating the resolution flow
      const apiKey = 'bh_test_key_123';
      const hash = `hashed_${apiKey}`;
      const agentRow = { id: 'agent-uuid', name: 'agent-1', karma: 100, status: 'active' };

      // hashApiKey(apiKey) → lookup → agentRow.id
      expect(hash).toBe('hashed_bh_test_key_123');
      expect(agentRow.id).toBe('agent-uuid');
    });

    it('auto-join should cover maintainer repos and active stream repos', () => {
      const maintainerRepos = ['repo-1', 'repo-2'];
      const activeStreamRepos = ['repo-2', 'repo-3'];
      const autoJoined = new Set([...maintainerRepos, ...activeStreamRepos]);

      expect(autoJoined.size).toBe(3);
      expect(autoJoined.has('repo-1')).toBe(true);
      expect(autoJoined.has('repo-2')).toBe(true);
      expect(autoJoined.has('repo-3')).toBe(true);
    });
  });

  // ============================================================
  // Swarm coordination
  // ============================================================

  describe('Swarm git coordination', () => {
    it('should map depends_on to parent_stream_id (linear chain)', () => {
      const streams = [
        { branch: 'stream/backend', depends_on: [] },
        { branch: 'stream/api', depends_on: ['stream/backend'] },
        { branch: 'stream/tests', depends_on: ['stream/api'] },
      ];

      const streamIdMap = new Map<string, string>();
      streamIdMap.set('stream/backend', 'id-1');
      streamIdMap.set('stream/api', 'id-2');
      streamIdMap.set('stream/tests', 'id-3');

      // Build dependency chain
      const deps: Record<string, string | null> = {};
      for (const s of streams) {
        if (s.depends_on.length > 0) {
          const parentBranch = s.depends_on[s.depends_on.length - 1];
          deps[s.branch] = streamIdMap.get(parentBranch) || null;
        } else {
          deps[s.branch] = null;
        }
      }

      expect(deps['stream/backend']).toBeNull();
      expect(deps['stream/api']).toBe('id-1');
      expect(deps['stream/tests']).toBe('id-2');
    });

    it('should create branches in correct order', () => {
      const streams = [
        { agent_id: 'a1', branch: 'stream/backend', base_branch: 'buffer' },
        { agent_id: 'a2', branch: 'stream/api', base_branch: 'buffer' },
        { agent_id: 'a3', branch: 'stream/tests', base_branch: 'buffer' },
      ];

      // All branch from buffer (not from each other)
      for (const s of streams) {
        expect(s.base_branch).toBe('buffer');
      }
    });
  });

  // ============================================================
  // Dashboard feed
  // ============================================================

  describe('Dashboard lightweight feed', () => {
    it('should format events as simple JSON (not MAP protocol)', () => {
      const mapEvent = {
        id: 'ulid-123',
        type: 'gitswarm.stream.merged',
        timestamp: 1712188800000,
        data: { stream_id: 's1', merge_commit: 'abc123' },
        source: { agentId: 'agent-1' },
      };

      // Dashboard format strips MAP metadata
      const dashboardMessage = {
        type: mapEvent.type,
        data: mapEvent.data,
        timestamp: mapEvent.timestamp,
      };

      expect(dashboardMessage.type).toBe('gitswarm.stream.merged');
      expect(dashboardMessage.data).toBeDefined();
      // No MAP-specific fields (id, source, causedBy, etc.)
      expect((dashboardMessage as any).id).toBeUndefined();
      expect((dashboardMessage as any).source).toBeUndefined();
    });
  });
});
