/**
 * GitSwarm MAP Server
 *
 * Creates and configures a MAP (Multi-Agent Protocol) server for GitSwarm.
 * Agents connect via WebSocket, register with their GitSwarm API key,
 * join repo scopes, and interact through x-gitswarm/* extension methods.
 *
 * Key responsibilities:
 * - Agent identity resolution (API key → GitSwarm UUID)
 * - Repo-as-scope model (each repo is a MAP scope)
 * - Auto-join logic (maintainer repos + active stream repos)
 * - Event delivery to subscribed agents
 */

import { MAPServer } from '@multi-agent-protocol/sdk/server';
import type { Stream } from '@multi-agent-protocol/sdk';
import { query } from '../config/database.js';
import { hashApiKey } from '../middleware/authenticate.js';
import { setMapServer } from './map-events.js';
import { createGitSwarmHandlers } from './map-handlers.js';

// ============================================================
// Agent identity resolution
// ============================================================

/**
 * Resolve a GitSwarm agent from a MAP registration's metadata.
 * Agents present their API key in metadata.api_key during MAP agents/register.
 */
async function resolveAgentFromMetadata(metadata?: Record<string, unknown>): Promise<{
  id: string;
  name: string;
  karma: number;
} | null> {
  const apiKey = metadata?.api_key as string | undefined;
  if (!apiKey) return null;

  const apiKeyHash = hashApiKey(apiKey);
  const result = await query(
    'SELECT id, name, karma, status FROM agents WHERE api_key_hash = $1',
    [apiKeyHash]
  );

  if (result.rows.length === 0 || result.rows[0].status !== 'active') {
    return null;
  }

  return result.rows[0] as { id: string; name: string; karma: number };
}

// ============================================================
// Scope management
// ============================================================

/**
 * Create MAP scopes for all active Gitea-backed repos.
 * Called on server startup.
 */
async function initializeRepoScopes(server: MAPServer): Promise<number> {
  const repos = await query(`
    SELECT id, name, gitea_owner, gitea_repo_name
    FROM gitswarm_repos
    WHERE status = 'active' AND git_backend = 'gitea'
  `);

  for (const repo of repos.rows) {
    try {
      server.scopes.create({
        name: `repo:${repo.id}`,
        metadata: {
          repo_name: repo.name,
          gitea_owner: repo.gitea_owner,
          gitea_repo_name: repo.gitea_repo_name,
        },
      });
    } catch {
      // Scope may already exist from a previous startup
    }
  }

  return repos.rows.length;
}

/**
 * Resolve a repo UUID to its MAP scope ID.
 * MAP scopes have auto-generated IDs (ULIDs) that differ from the scope name.
 * The scope name is `repo:{repoId}`, but join/leave/emit need the scope ID.
 */
export function resolveRepoScopeId(server: MAPServer, repoId: string): string | null {
  const scopeName = `repo:${repoId}`;
  const scopes = server.scopes.list();
  const scope = scopes.find((s: any) => s.name === scopeName);
  return scope?.id || null;
}

/**
 * Create a MAP scope for a newly created repo.
 * Returns the scope ID.
 */
export function createRepoScope(server: MAPServer, repoId: string, metadata?: Record<string, unknown>): string | null {
  try {
    const scope = server.scopes.create({
      name: `repo:${repoId}`,
      metadata: metadata || {},
    });
    return scope.id;
  } catch {
    // Scope may already exist — return existing ID
    return resolveRepoScopeId(server, repoId);
  }
}

/**
 * Auto-join an agent to their relevant repo scopes.
 * Joins repos where agent is a maintainer or has active streams.
 */
async function autoJoinScopes(server: MAPServer, mapAgentId: string, gitswarmAgentId: string): Promise<string[]> {
  // Repos where agent is maintainer/owner
  const maintained = await query(`
    SELECT repo_id FROM gitswarm_maintainers WHERE agent_id = $1
  `, [gitswarmAgentId]);

  // Repos where agent has active streams
  const active = await query(`
    SELECT DISTINCT repo_id FROM gitswarm_streams
    WHERE agent_id = $1 AND status IN ('active', 'in_review')
  `, [gitswarmAgentId]);

  const repoIds = new Set<string>([
    ...maintained.rows.map((r: any) => r.repo_id),
    ...active.rows.map((r: any) => r.repo_id),
  ]);

  const joined: string[] = [];
  for (const repoId of repoIds) {
    const scopeId = resolveRepoScopeId(server, repoId);
    if (scopeId) {
      try {
        server.scopes.join(scopeId, mapAgentId);
        joined.push(scopeId);
      } catch {
        // Agent may already be in scope
      }
    }
  }

  return joined;
}

// ============================================================
// MAP Server factory
// ============================================================

/**
 * Create and configure the GitSwarm MAP server.
 */
export function createGitSwarmMAPServer(): MAPServer {
  const server = new MAPServer({
    name: 'gitswarm',
    version: '0.3.0',
    additionalHandlers: createGitSwarmHandlers(),
  });

  // Wire up agent registration: resolve API key → GitSwarm identity
  server.eventBus.on('agent.registered', async (event: any) => {
    const { agentId, metadata } = event.data || {};
    if (!metadata?.api_key) return;

    const agent = await resolveAgentFromMetadata(metadata);
    if (agent) {
      // Store the GitSwarm agent ID mapping on the registered agent's metadata
      const registeredAgent = server.agents.get(agentId);
      if (registeredAgent) {
        server.agents.updateMetadata(agentId, {
          ...registeredAgent.metadata,
          gitswarm_agent_id: agent.id,
          gitswarm_agent_name: agent.name,
          gitswarm_karma: agent.karma,
        });
      }

      // Auto-join relevant repo scopes
      await autoJoinScopes(server, agentId, agent.id);
    }
  });

  // Register the server for event emission
  setMapServer(server);

  return server;
}

/**
 * Initialize the MAP server: create scopes for existing repos.
 * Call after database is ready.
 */
export async function initializeMAPServer(server: MAPServer): Promise<void> {
  try {
    const count = await initializeRepoScopes(server);
    if (count > 0) {
      console.log(`MAP server: initialized ${count} repo scopes`);
    }
  } catch (err) {
    console.warn('MAP server scope initialization failed:', (err as Error).message);
  }
}

/**
 * Resolve a GitSwarm agent ID from a MAP session/agent context.
 * Used by x-gitswarm/* handlers to identify the calling agent.
 */
export function resolveGitSwarmAgentId(server: MAPServer, mapAgentId: string): string | null {
  const agent = server.agents.get(mapAgentId);
  return (agent?.metadata?.gitswarm_agent_id as string) || null;
}
