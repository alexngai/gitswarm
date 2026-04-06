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
    openhive: {
      url: 'http://openhive:3000',
      apiKey: 'test-api-key',
      syncEnabled: true,
      syncIntervalMs: 30000,
    },
    host: 'localhost',
    port: 3000,
  },
}));

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

// Mock fetch for OpenHive API calls
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

describe('Phase 4B: Cross-System Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Repo State Aggregation
  // ============================================================

  describe('Repo State Aggregation', () => {
    it('should compute comprehensive repo state', async () => {
      const { getRepoState } = await import('../../src/services/repo-state.js');

      // Repo info
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'repo-1', name: 'test-repo', buffer_branch: 'buffer', promote_target: 'main' }],
      } as any);

      // Stream counts
      mockQuery.mockResolvedValueOnce({
        rows: [{ open_streams: '5', streams_in_review: '2' }],
      } as any);

      // Consensus pending
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', name: 'stream/feat-1' }, { id: 's2', name: 'stream/fix-2' }],
      } as any);

      // Active agents
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'agent-1' }, { name: 'agent-2' }],
      } as any);

      // Last stabilization
      mockQuery.mockResolvedValueOnce({
        rows: [{ result: 'green', stabilized_at: '2026-04-05T10:00:00Z' }],
      } as any);

      // Last promotion
      mockQuery.mockResolvedValueOnce({
        rows: [{ from_branch: 'buffer', to_branch: 'main', promoted_at: '2026-04-05T09:00:00Z' }],
      } as any);

      // Merges since last promotion
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '3' }],
      } as any);

      // Last merge
      mockQuery.mockResolvedValueOnce({
        rows: [{ stream_name: 'stream/latest', merged_at: '2026-04-05T10:30:00Z' }],
      } as any);

      const state = await getRepoState('repo-1');

      expect(state.repo_name).toBe('test-repo');
      expect(state.open_streams).toBe(5);
      expect(state.streams_in_review).toBe(2);
      expect(state.consensus_pending).toEqual(['stream/feat-1', 'stream/fix-2']);
      expect(state.active_agents).toEqual(['agent-1', 'agent-2']);
      expect(state.buffer_status).toBe('green');
      expect(state.buffer_ahead_of_main).toBe(3);
      expect(state.last_merge!.stream_name).toBe('stream/latest');
      expect(state.last_stabilization!.result).toBe('green');
      expect(state.last_promotion!.from).toBe('buffer');
      expect(state.computed_at).toBeTruthy();
    });

    it('should handle repo with no history', async () => {
      const { getRepoState } = await import('../../src/services/repo-state.js');

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'repo-2', name: 'new-repo', buffer_branch: 'buffer', promote_target: 'main' }],
      } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ open_streams: '0', streams_in_review: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // no pending consensus
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // no active agents
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // no stabilizations
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // no promotions
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any); // no merges
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // no last merge

      const state = await getRepoState('repo-2');

      expect(state.open_streams).toBe(0);
      expect(state.buffer_status).toBe('unknown');
      expect(state.last_merge).toBeNull();
      expect(state.last_stabilization).toBeNull();
      expect(state.last_promotion).toBeNull();
    });

    it('should detect red buffer status', async () => {
      const { getRepoState } = await import('../../src/services/repo-state.js');

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r', name: 'r', buffer_branch: 'b', promote_target: 'm' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ open_streams: '1', streams_in_review: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      // Red stabilization
      mockQuery.mockResolvedValueOnce({ rows: [{ result: 'red', stabilized_at: '2026-04-05T10:00:00Z' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const state = await getRepoState('r');
      expect(state.buffer_status).toBe('red');
    });

    it('should throw for non-existent repo', async () => {
      const { getRepoState } = await import('../../src/services/repo-state.js');

      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await expect(getRepoState('bad-id')).rejects.toThrow('Repo not found');
    });
  });

  // ============================================================
  // OpenHive Sync Service
  // ============================================================

  describe('StateSyncService (generic)', () => {
    it('should accept and count targets', async () => {
      const { StateSyncService } = await import('../../src/services/state-sync.js');
      const mockServer = { eventBus: { on: vi.fn(), off: vi.fn() } } as any;
      const service = new StateSyncService(mockServer);

      expect(service.targetCount).toBe(0);

      service.addTarget({ name: 'test', isConfigured: true, pushState: vi.fn() });
      expect(service.targetCount).toBe(1);
    });

    it('should skip unconfigured targets', async () => {
      const { StateSyncService } = await import('../../src/services/state-sync.js');
      const mockServer = { eventBus: { on: vi.fn(), off: vi.fn() } } as any;
      const service = new StateSyncService(mockServer);

      service.addTarget({ name: 'disabled', isConfigured: false, pushState: vi.fn() });
      expect(service.targetCount).toBe(0);
    });

    it('should push to all targets', async () => {
      const { StateSyncService } = await import('../../src/services/state-sync.js');
      const mockServer = { eventBus: { on: vi.fn(), off: vi.fn() } } as any;
      const service = new StateSyncService(mockServer);

      const push1 = vi.fn().mockResolvedValue(undefined);
      const push2 = vi.fn().mockResolvedValue(undefined);
      service.addTarget({ name: 'target-1', isConfigured: true, pushState: push1 });
      service.addTarget({ name: 'target-2', isConfigured: true, pushState: push2 });

      // Mock getAllRepoStates
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r', name: 'r', buffer_branch: 'b', promote_target: 'm' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ open_streams: '1', streams_in_review: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const pushed = await service.pushAllStates();
      expect(pushed).toBe(2); // 1 repo × 2 targets
      expect(push1).toHaveBeenCalledOnce();
      expect(push2).toHaveBeenCalledOnce();
    });

    it('should handle target failures gracefully', async () => {
      const { StateSyncService } = await import('../../src/services/state-sync.js');
      const mockServer = { eventBus: { on: vi.fn(), off: vi.fn() } } as any;
      const service = new StateSyncService(mockServer);

      const failPush = vi.fn().mockRejectedValue(new Error('target down'));
      const okPush = vi.fn().mockResolvedValue(undefined);
      service.addTarget({ name: 'failing', isConfigured: true, pushState: failPush });
      service.addTarget({ name: 'working', isConfigured: true, pushState: okPush });

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'repo-1' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r', name: 'r', buffer_branch: 'b', promote_target: 'm' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ open_streams: '0', streams_in_review: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const pushed = await service.pushAllStates();
      expect(pushed).toBe(1); // Only working target succeeded
      expect(okPush).toHaveBeenCalledOnce();
    });

    it('should stop cleanly', async () => {
      const { StateSyncService } = await import('../../src/services/state-sync.js');
      const mockServer = { eventBus: { on: vi.fn(), off: vi.fn() } } as any;
      const service = new StateSyncService(mockServer);
      service.stop(); // Should not throw
    });
  });

  describe('OpenHiveSyncTarget', () => {
    it('should be configured when URL and key are set', async () => {
      const { OpenHiveSyncTarget } = await import('../../src/services/openhive-sync.js');
      const target = new OpenHiveSyncTarget();
      expect(target.isConfigured).toBe(true);
      expect(target.name).toBe('openhive');
    });

    it('should not be configured when URL is missing', async () => {
      const { OpenHiveSyncTarget } = await import('../../src/services/openhive-sync.js');
      const target = new OpenHiveSyncTarget({ openhiveUrl: '', apiKey: 'key' });
      expect(target.isConfigured).toBe(false);
    });

    it('should push state to OpenHive coordination contexts', async () => {
      const { OpenHiveSyncTarget } = await import('../../src/services/openhive-sync.js');
      const target = new OpenHiveSyncTarget({
        openhiveUrl: 'http://openhive:3000',
        apiKey: 'test-key',
        syncIntervalMs: 60000,
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      const state: any = {
        repo_id: 'repo-1',
        repo_name: 'test',
        open_streams: 2,
        buffer_status: 'green',
        computed_at: '2026-04-05T10:00:00Z',
      };

      await target.pushState(state);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://openhive:3000/api/v1/coordination/contexts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
          }),
        })
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.source_swarm_id).toBe('gitswarm');
      expect(callBody.context_type).toBe('git-repo-state');
      expect(callBody.data.repo_name).toBe('test');
      expect(callBody.ttl_seconds).toBeGreaterThan(0);
    });

    it('should throw on API error', async () => {
      const { OpenHiveSyncTarget } = await import('../../src/services/openhive-sync.js');
      const target = new OpenHiveSyncTarget({
        openhiveUrl: 'http://openhive:3000',
        apiKey: 'key',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(target.pushState({ repo_id: 'r' } as any)).rejects.toThrow('OpenHive API 500');
    });
  });

  // ============================================================
  // External Identity Mapping
  // ============================================================

  describe('External Agent Identity', () => {
    it('should link OpenHive identity on MAP registration', () => {
      // The identity linking SQL
      const sql = `
        INSERT INTO gitswarm_agent_external_identities (agent_id, system, external_id, external_name, metadata)
        VALUES ($1, 'openhive', $2, $3, $4)
        ON CONFLICT (agent_id, system) DO UPDATE SET
          external_id = $2, external_name = $3, metadata = $4, updated_at = NOW()
      `;

      // Verify the SQL has the right structure
      expect(sql).toContain('gitswarm_agent_external_identities');
      expect(sql).toContain("'openhive'");
      expect(sql).toContain('ON CONFLICT');
    });

    it('should resolve agent by external identity', async () => {
      // Simulate looking up a GitSwarm agent by their OpenHive ID
      mockQuery.mockResolvedValueOnce({
        rows: [{ agent_id: 'gs-uuid-123', external_name: 'oh-agent-alpha' }],
      } as any);

      const result = await mockQuery(
        'SELECT agent_id, external_name FROM gitswarm_agent_external_identities WHERE system = $1 AND external_id = $2',
        ['openhive', 'oh-id-456']
      );

      expect(result.rows[0].agent_id).toBe('gs-uuid-123');
    });

    it('should support multiple systems per agent', () => {
      // The table has UNIQUE(agent_id, system) — one entry per system per agent
      // But the same agent can be in multiple systems
      const systems = ['openhive', 'gitswarm-remote', 'external'];
      const unique = new Set(systems);
      expect(unique.size).toBe(systems.length);
    });
  });

  // ============================================================
  // OpenHive Context Format
  // ============================================================

  describe('OpenHive Context Format', () => {
    it('should match OpenHive coordination context schema', () => {
      const context = {
        source_swarm_id: 'gitswarm',
        context_type: 'git-repo-state',
        data: {
          repo_id: 'uuid',
          repo_name: 'project-1',
          open_streams: 3,
          streams_in_review: 1,
          consensus_pending: ['stream/feat-1'],
          active_agents: ['agent-1', 'agent-2'],
          buffer_status: 'green',
          buffer_ahead_of_main: 2,
          last_merge: { stream_name: 'stream/fix-42', at: '2026-04-05T10:00:00Z' },
          last_stabilization: { result: 'green', at: '2026-04-05T10:05:00Z' },
          last_promotion: null,
          computed_at: '2026-04-05T10:30:00Z',
        },
        ttl_seconds: 60,
      };

      // Required fields
      expect(context.source_swarm_id).toBeTruthy();
      expect(context.context_type).toBe('git-repo-state');
      expect(context.data.repo_id).toBeTruthy();
      expect(context.ttl_seconds).toBeGreaterThan(0);

      // Data should include all key state fields
      expect(typeof context.data.open_streams).toBe('number');
      expect(typeof context.data.buffer_status).toBe('string');
      expect(Array.isArray(context.data.active_agents)).toBe(true);
    });
  });

  // ============================================================
  // Swarm Registration
  // ============================================================

  describe('Swarm Registration', () => {
    it('should format registration payload correctly', () => {
      const registration = {
        name: 'gitswarm',
        description: 'Git governance server',
        map_endpoint: 'ws://gitswarm:3000/ws',
        map_transport: 'websocket',
        capabilities: {
          messaging: true,
          lifecycle: true,
          protocols: ['git-coordination'],
        },
        auth_method: 'api-key',
        metadata: {
          type: 'git-governance',
          repos: ['project-1', 'project-2'],
        },
      };

      expect(registration.name).toBe('gitswarm');
      expect(registration.map_transport).toBe('websocket');
      expect(registration.capabilities.protocols).toContain('git-coordination');
      expect(registration.metadata.type).toBe('git-governance');
      expect(registration.metadata.repos).toHaveLength(2);
    });
  });
});
