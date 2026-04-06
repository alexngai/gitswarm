import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: {
    gitea: { url: '', adminToken: '', internalSecret: '', sshUrl: '', externalUrl: '' },
    defaultGitBackend: 'gitea',
  },
}));

describe('MAP Events Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('emitGitSwarmEvent', () => {
    it('should emit to MAP EventBus with resolved scope ID', async () => {
      const { setMapServer, emitGitSwarmEvent, GITSWARM_EVENTS } = await import('../../src/services/map-events.js');

      const mockEventBus = { emit: vi.fn() };
      const mockScopes = {
        list: vi.fn().mockReturnValue([
          { id: 'scope-ulid-123', name: 'repo:repo-uuid' },
        ]),
      };
      setMapServer({ eventBus: mockEventBus, scopes: mockScopes } as any);

      emitGitSwarmEvent(GITSWARM_EVENTS.STREAM_CREATED, {
        stream_id: 's1',
        branch: 'stream/feat-1',
      }, 'repo-uuid', 'agent-uuid');

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gitswarm.stream.created',
          data: expect.objectContaining({
            stream_id: 's1',
            branch: 'stream/feat-1',
            repo_id: 'repo-uuid',
            timestamp: expect.any(String),
          }),
          source: { agentId: 'agent-uuid' },
          scope: 'scope-ulid-123',  // Resolved scope ID, not scope name
        })
      );
    });

    it('should handle missing agent ID', async () => {
      const { setMapServer, emitGitSwarmEvent, GITSWARM_EVENTS } = await import('../../src/services/map-events.js');

      const mockEventBus = { emit: vi.fn() };
      const mockScopes = {
        list: vi.fn().mockReturnValue([
          { id: 'scope-ulid-456', name: 'repo:repo-uuid' },
        ]),
      };
      setMapServer({ eventBus: mockEventBus, scopes: mockScopes } as any);

      emitGitSwarmEvent(GITSWARM_EVENTS.CONSENSUS_REACHED, {
        stream_id: 's1',
        ratio: 0.75,
      }, 'repo-uuid');

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          source: undefined,
          scope: 'scope-ulid-456',
        })
      );
    });

    it('should not throw when MAP server is not set', async () => {
      const { setMapServer, emitGitSwarmEvent, GITSWARM_EVENTS } = await import('../../src/services/map-events.js');

      setMapServer(null as any);

      // Should not throw — just silently skip
      expect(() => {
        emitGitSwarmEvent(GITSWARM_EVENTS.MERGE_COMPLETED, { stream_id: 's1' }, 'repo-1');
      }).not.toThrow();
    });
  });

  describe('emitSystemEvent', () => {
    it('should emit without repo scope', async () => {
      const { setMapServer, emitSystemEvent } = await import('../../src/services/map-events.js');

      const mockEventBus = { emit: vi.fn() };
      setMapServer({ eventBus: mockEventBus } as any);

      emitSystemEvent('gitswarm.system.startup', { version: '0.3.0' });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gitswarm.system.startup',
          data: expect.objectContaining({ version: '0.3.0' }),
          // No scope field for system events
        })
      );

      // Verify no scope was set
      const emittedEvent = mockEventBus.emit.mock.calls[0][0];
      expect(emittedEvent.scope).toBeUndefined();
    });
  });
});
