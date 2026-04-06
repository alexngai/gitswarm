/**
 * Swarm Git Coordination Routes
 *
 * REST endpoint for batch-creating streams with dependency ordering.
 * Accepts pre-decomposed work — does NOT do task decomposition (D11).
 * The MAP equivalent is x-gitswarm/swarm/setup.
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';
import { getBackendForRepo } from '../../services/backend-factory.js';
import { emitGitSwarmEvent, GITSWARM_EVENTS } from '../../services/map-events.js';

const permissionService = new GitSwarmPermissionService();
const rateLimit = createRateLimiter('gitswarm_write');

export async function swarmRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {

  /**
   * POST /gitswarm/repos/:repoId/swarm
   * Batch create streams with dependency ordering for a swarm of agents.
   */
  app.post('/gitswarm/repos/:repoId/swarm', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['streams'],
        properties: {
          task_id: { type: 'string' },
          streams: {
            type: 'array',
            items: {
              type: 'object',
              required: ['agent_id', 'branch'],
              properties: {
                agent_id: { type: 'string' },
                branch: { type: 'string' },
                base_branch: { type: 'string' },
                name: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { task_id, streams } = request.body as {
      task_id?: string;
      streams: Array<{
        agent_id: string;
        branch: string;
        base_branch?: string;
        name?: string;
        depends_on?: string[];
      }>;
    };

    // Check maintainer permission
    const perm = await permissionService.canPerform(request.agent.id, repoId, 'merge');
    if (!perm.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Swarm setup requires maintainer permissions',
      });
    }

    // Verify repo exists
    const repoResult = await query(
      'SELECT id, buffer_branch, default_branch FROM gitswarm_repos WHERE id = $1 AND status = $2',
      [repoId, 'active']
    );
    if (repoResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const backend = await getBackendForRepo(repoId);
    const createdStreams: any[] = [];
    const streamIdMap = new Map<string, string>(); // branch → stream_id

    // First pass: create all streams
    for (const s of streams) {
      const crypto = await import('crypto');
      const streamId = crypto.randomUUID();

      const result = await query(`
        INSERT INTO gitswarm_streams (
          id, repo_id, agent_id, name, branch, base_branch, source, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'swarm', 'active')
        RETURNING *
      `, [streamId, repoId, s.agent_id, s.name || s.branch, s.branch, s.base_branch || 'buffer']);

      streamIdMap.set(s.branch, streamId);
      createdStreams.push(result.rows[0]);

      // Create branch in Gitea
      try {
        await backend.createBranch(repoId, s.branch, s.base_branch || 'buffer');
      } catch {
        // Branch may already exist
      }
    }

    // Second pass: set parent_stream_id for dependency ordering
    for (const s of streams) {
      if (s.depends_on && s.depends_on.length > 0) {
        // Use the last dependency as parent (linear chain)
        const parentBranch = s.depends_on[s.depends_on.length - 1];
        const parentId = streamIdMap.get(parentBranch);
        const streamId = streamIdMap.get(s.branch);
        if (parentId && streamId) {
          await query(
            'UPDATE gitswarm_streams SET parent_stream_id = $1 WHERE id = $2',
            [parentId, streamId]
          );
        }
      }
    }

    // Get clone URL
    let cloneUrl: string | undefined;
    try {
      const access = await backend.getCloneAccess(repoId);
      cloneUrl = access.cloneUrl;
    } catch {
      // Non-fatal
    }

    emitGitSwarmEvent(GITSWARM_EVENTS.SWARM_CREATED, {
      task_id,
      stream_count: createdStreams.length,
      branches: createdStreams.map(s => s.branch),
    }, repoId, request.agent.id);

    reply.status(201);
    return {
      streams: createdStreams.map(s => ({
        stream_id: s.id,
        stream_number: s.stream_number,
        branch: s.branch,
        agent_id: s.agent_id,
        status: s.status,
      })),
      clone_url: cloneUrl,
    };
  });
}
