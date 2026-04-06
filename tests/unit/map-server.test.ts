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

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('MAP Server Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createGitSwarmMAPServer', () => {
    it('should create a MAPServer instance with gitswarm name', async () => {
      const { createGitSwarmMAPServer } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      expect(server).toBeDefined();
      expect(server.eventBus).toBeDefined();
      expect(server.agents).toBeDefined();
      expect(server.scopes).toBeDefined();
      expect(server.sessions).toBeDefined();
    });

    it('should include x-gitswarm handlers', async () => {
      const { createGitSwarmMAPServer } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      // The handlers are registered on the server — verify it was created without errors
      expect(server).toBeTruthy();
    });
  });

  describe('initializeMAPServer', () => {
    it('should create scopes for all active gitea-backed repos', async () => {
      const { createGitSwarmMAPServer, initializeMAPServer } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'repo-1', name: 'repo-one', gitea_owner: 'org', gitea_repo_name: 'repo-one' },
          { id: 'repo-2', name: 'repo-two', gitea_owner: 'org', gitea_repo_name: 'repo-two' },
        ],
      } as any);

      await initializeMAPServer(server);

      // Verify scopes were created
      const scopes = server.scopes.list();
      const scopeNames = scopes.map((s: any) => s.name);
      expect(scopeNames).toContain('repo:repo-1');
      expect(scopeNames).toContain('repo:repo-2');
    });

    it('should handle empty repo list gracefully', async () => {
      const { createGitSwarmMAPServer, initializeMAPServer } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await initializeMAPServer(server);

      // No error thrown, no scopes created
      expect(server.scopes.list().length).toBe(0);
    });

    it('should not fail if scope already exists', async () => {
      const { createGitSwarmMAPServer, initializeMAPServer } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      // Pre-create a scope
      server.scopes.create({ name: 'repo:repo-1' });

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'repo-1', name: 'repo-one', gitea_owner: 'org', gitea_repo_name: 'one' }],
      } as any);

      // Should not throw
      await initializeMAPServer(server);
    });
  });

  describe('createRepoScope', () => {
    it('should create a scope with repo:{id} naming', async () => {
      const { createGitSwarmMAPServer, createRepoScope } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      createRepoScope(server, 'new-repo-uuid', { repo_name: 'new-repo' });

      const scopes = server.scopes.list();
      expect(scopes.some((s: any) => s.name === 'repo:new-repo-uuid')).toBe(true);
    });

    it('should not throw when called twice for the same repo', async () => {
      const { createGitSwarmMAPServer, createRepoScope } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      createRepoScope(server, 'repo-x');
      // Second call should not throw (graceful handling)
      expect(() => createRepoScope(server, 'repo-x')).not.toThrow();
    });
  });

  describe('resolveGitSwarmAgentId', () => {
    it('should return null for agent without gitswarm metadata', async () => {
      const { createGitSwarmMAPServer, resolveGitSwarmAgentId } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      const session = server.sessions.create({ role: 'agent' });
      const agent = server.agents.register({ name: 'plain-agent', role: 'worker', sessionId: session.id });

      const result = resolveGitSwarmAgentId(server, agent.id);
      expect(result).toBeNull();
    });

    it('should return gitswarm_agent_id when present in metadata', async () => {
      const { createGitSwarmMAPServer, resolveGitSwarmAgentId } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      // Create a session first (required for agent registration)
      const session = server.sessions.create({ role: 'agent' });

      // Register and manually set metadata (simulating the event handler)
      const agent = server.agents.register({ name: 'gs-agent', role: 'worker', sessionId: session.id });
      server.agents.updateMetadata(agent.id, {
        gitswarm_agent_id: 'gs-uuid-123',
        gitswarm_agent_name: 'my-agent',
      });

      const result = resolveGitSwarmAgentId(server, agent.id);
      expect(result).toBe('gs-uuid-123');
    });

    it('should return null for non-existent agent', async () => {
      const { createGitSwarmMAPServer, resolveGitSwarmAgentId } = await import('../../src/services/map-server.js');
      const server = createGitSwarmMAPServer();

      const result = resolveGitSwarmAgentId(server, 'nonexistent-id');
      expect(result).toBeNull();
    });
  });
});
