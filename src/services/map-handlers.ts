/**
 * GitSwarm MAP Extension Method Handlers
 *
 * Custom x-gitswarm/* methods registered on the MAP server.
 * These are the primary API for MAP-connected agents.
 *
 * Each handler resolves the calling agent from the MAP session,
 * checks permissions, performs the operation, and emits events.
 * Business logic is shared with REST endpoints where possible.
 */

import type { HandlerRegistry, HandlerContext } from '@multi-agent-protocol/sdk/server';
import { query, getClient } from '../config/database.js';
import { GitSwarmPermissionService } from './gitswarm-permissions.js';
import { getBackendForRepo } from './backend-factory.js';
import { emitGitSwarmEvent, GITSWARM_EVENTS } from './map-events.js';
import { resolveGitSwarmAgentId } from './map-server.js';

const permissionService = new GitSwarmPermissionService();

// Lazy-loaded MAP server reference (set after initialization)
let _mapServerRef: any = null;
export function setMapServerRef(server: any): void {
  _mapServerRef = server;
}

/**
 * Resolve the GitSwarm agent UUID from a MAP handler context.
 * Throws if no agent identity can be resolved.
 */
function getAgentId(ctx: HandlerContext): string {
  if (!_mapServerRef) throw new Error('MAP server not initialized');

  // Session may have multiple agents; use the first one
  const mapAgentId = ctx.session.agentIds?.[0];
  if (!mapAgentId) {
    throw new Error('No agent registered on this session. Call agents/register first.');
  }

  const gitswarmId = resolveGitSwarmAgentId(_mapServerRef, mapAgentId);
  if (!gitswarmId) {
    throw new Error('Agent identity not resolved. Provide api_key in registration metadata.');
  }

  return gitswarmId;
}

/**
 * Create all x-gitswarm/* MAP method handlers.
 */
export function createGitSwarmHandlers(): HandlerRegistry {
  return {
    /**
     * x-gitswarm/stream/create
     * Create a new stream (governed branch) in a repository.
     */
    'x-gitswarm/stream/create': async (params: any, ctx: HandlerContext) => {
      const agentId = getAgentId(ctx);
      const { repo_id, branch, base_branch, name } = params;

      if (!repo_id || !branch) {
        throw new Error('repo_id and branch are required');
      }

      // Validate repo exists
      const repoCheck = await query(
        'SELECT id FROM gitswarm_repos WHERE id = $1 AND status = $2',
        [repo_id, 'active']
      );
      if (repoCheck.rows.length === 0) {
        throw new Error('Repository not found');
      }

      // Check write permission
      const perm = await permissionService.canPerform(agentId, repo_id, 'write');
      if (!perm.allowed) {
        throw new Error('Insufficient permissions');
      }

      const crypto = await import('crypto');
      const streamId = crypto.randomUUID();

      const result = await query(`
        INSERT INTO gitswarm_streams (
          id, repo_id, agent_id, name, branch, base_branch, source, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'api', 'active')
        RETURNING *
      `, [streamId, repo_id, agentId, name || branch, branch, base_branch || 'main']);

      const stream = result.rows[0];

      // Create branch in Gitea
      try {
        const backend = await getBackendForRepo(repo_id);
        await backend.createBranch(repo_id, branch, base_branch || 'main');
      } catch (err) {
        // Branch may already exist — non-fatal
      }

      emitGitSwarmEvent(GITSWARM_EVENTS.STREAM_CREATED, {
        stream_id: stream.id,
        stream_number: stream.stream_number,
        branch,
        agent_id: agentId,
      }, repo_id, agentId);

      return {
        stream_id: stream.id,
        stream_number: stream.stream_number,
        branch: stream.branch,
        status: stream.status,
      };
    },

    /**
     * x-gitswarm/stream/review
     * Submit a review (consensus vote) on a stream.
     */
    'x-gitswarm/stream/review': async (params: any, ctx: HandlerContext) => {
      const agentId = getAgentId(ctx);
      const { stream_id, verdict, feedback } = params;

      if (!stream_id || !verdict) {
        throw new Error('stream_id and verdict are required');
      }

      if (!['approve', 'request_changes'].includes(verdict)) {
        throw new Error('verdict must be "approve" or "request_changes"');
      }

      // Get stream's repo
      const streamResult = await query(
        'SELECT repo_id, status FROM gitswarm_streams WHERE id = $1',
        [stream_id]
      );
      if (streamResult.rows.length === 0) throw new Error('Stream not found');

      const { repo_id, status } = streamResult.rows[0];

      // Insert review
      await query(`
        INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
          verdict = $3, feedback = $4, reviewed_at = NOW()
      `, [stream_id, agentId, verdict, feedback || '']);

      // Move to in_review if active
      if (status === 'active') {
        await query(`
          UPDATE gitswarm_streams SET status = 'in_review', updated_at = NOW()
          WHERE id = $1 AND status = 'active'
        `, [stream_id]);
      }

      emitGitSwarmEvent(GITSWARM_EVENTS.REVIEW_SUBMITTED, {
        stream_id,
        reviewer_id: agentId,
        verdict,
      }, repo_id, agentId);

      // Check consensus
      const consensus = await checkConsensusDetailed(stream_id, repo_id);

      if (consensus.reached) {
        emitGitSwarmEvent(GITSWARM_EVENTS.CONSENSUS_REACHED, {
          stream_id,
          ...consensus,
        }, repo_id);
      }

      return { consensus };
    },

    /**
     * x-gitswarm/stream/merge
     * Governance-gated merge. Only succeeds if consensus is reached.
     */
    'x-gitswarm/stream/merge': async (params: any, ctx: HandlerContext) => {
      const agentId = getAgentId(ctx);
      const { stream_id } = params;

      if (!stream_id) throw new Error('stream_id is required');

      const streamResult = await query(`
        SELECT id, repo_id, status, branch FROM gitswarm_streams WHERE id = $1
      `, [stream_id]);
      if (streamResult.rows.length === 0) throw new Error('Stream not found');

      const stream = streamResult.rows[0];

      if (stream.status === 'merged') throw new Error('Stream already merged');
      if (stream.status === 'abandoned') throw new Error('Stream is abandoned');

      // Check consensus
      const consensus = await checkConsensusDetailed(stream_id, stream.repo_id);
      if (!consensus.reached) {
        return {
          merged: false,
          reason: 'Consensus not reached',
          consensus,
        };
      }

      // Get repo config
      const repo = await query(
        'SELECT buffer_branch FROM gitswarm_repos WHERE id = $1',
        [stream.repo_id]
      );
      const bufferBranch = repo.rows[0]?.buffer_branch || 'buffer';

      // Execute merge in transaction
      const client = await getClient();
      try {
        await client.query('BEGIN');

        await client.query(`
          INSERT INTO gitswarm_pending_merges (repo_id, stream_id, status, expires_at)
          VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')
        `, [stream.repo_id, stream_id]);

        await client.query(`
          INSERT INTO gitswarm_merges (repo_id, stream_id, agent_id, target_branch)
          VALUES ($1, $2, $3, $4)
        `, [stream.repo_id, stream_id, agentId, bufferBranch]);

        const mergeResult = await client.query(`
          UPDATE gitswarm_streams SET status = 'merged', review_status = 'approved', updated_at = NOW()
          WHERE id = $1 AND status IN ('active', 'in_review')
          RETURNING *
        `, [stream_id]);

        if (mergeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error('Stream status changed during merge');
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      emitGitSwarmEvent(GITSWARM_EVENTS.MERGE_COMPLETED, {
        stream_id,
        target_branch: bufferBranch,
        agent_id: agentId,
      }, stream.repo_id, agentId);

      return { merged: true, stream_id, target_branch: bufferBranch };
    },

    /**
     * x-gitswarm/consensus/check
     * Query the live consensus state for a stream.
     */
    'x-gitswarm/consensus/check': async (params: any, _ctx: HandlerContext) => {
      const { stream_id } = params;
      if (!stream_id) throw new Error('stream_id is required');

      const streamResult = await query(
        'SELECT repo_id FROM gitswarm_streams WHERE id = $1',
        [stream_id]
      );
      if (streamResult.rows.length === 0) throw new Error('Stream not found');

      return checkConsensusDetailed(stream_id, streamResult.rows[0].repo_id);
    },

    /**
     * x-gitswarm/task/claim
     * Claim a task with optimistic locking.
     */
    'x-gitswarm/task/claim': async (params: any, ctx: HandlerContext) => {
      const agentId = getAgentId(ctx);
      const { task_id } = params;

      if (!task_id) throw new Error('task_id is required');

      // Optimistic claim: only succeeds if task is still open
      const result = await query(`
        INSERT INTO gitswarm_task_claims (task_id, agent_id, status)
        SELECT $1, $2, 'active'
        WHERE EXISTS (
          SELECT 1 FROM gitswarm_tasks WHERE id = $1 AND status = 'open'
        )
        RETURNING *
      `, [task_id, agentId]);

      if (result.rows.length === 0) {
        throw new Error('Task not available for claiming (may be already claimed or closed)');
      }

      // Update task status
      await query(`
        UPDATE gitswarm_tasks SET status = 'claimed', updated_at = NOW()
        WHERE id = $1 AND status = 'open'
      `, [task_id]);

      const task = await query('SELECT * FROM gitswarm_tasks WHERE id = $1', [task_id]);

      emitGitSwarmEvent(GITSWARM_EVENTS.TASK_CLAIMED, {
        task_id,
        agent_id: agentId,
      }, task.rows[0]?.repo_id, agentId);

      return { claimed: true, task: task.rows[0], claim: result.rows[0] };
    },

    /**
     * x-gitswarm/swarm/setup
     * Batch create streams with dependency ordering.
     * Accepts pre-decomposed work — does NOT do task decomposition (D11).
     */
    'x-gitswarm/swarm/setup': async (params: any, ctx: HandlerContext) => {
      const agentId = getAgentId(ctx);
      const { repo_id, task_id, streams } = params;

      if (!repo_id || !streams || !Array.isArray(streams)) {
        throw new Error('repo_id and streams array are required');
      }

      // Validate repo exists
      const repoCheck = await query(
        'SELECT id FROM gitswarm_repos WHERE id = $1 AND status = $2',
        [repo_id, 'active']
      );
      if (repoCheck.rows.length === 0) {
        throw new Error('Repository not found');
      }

      // Check maintainer permission
      const perm = await permissionService.canPerform(agentId, repo_id, 'merge');
      if (!perm.allowed) {
        throw new Error('Swarm setup requires maintainer permissions');
      }

      const backend = await getBackendForRepo(repo_id);
      const createdStreams: any[] = [];
      const streamIdMap = new Map<string, string>(); // branch → stream_id

      // Use transaction to ensure atomic creation of all streams + dependencies
      const client = await getClient();
      try {
        await client.query('BEGIN');

        // First pass: create all streams
        for (const s of streams) {
          const crypto = await import('crypto');
          const streamId = crypto.randomUUID();

          const result = await client.query(`
            INSERT INTO gitswarm_streams (
              id, repo_id, agent_id, name, branch, base_branch, source, status
            ) VALUES ($1, $2, $3, $4, $5, $6, 'swarm', 'active')
            RETURNING *
          `, [streamId, repo_id, s.agent_id, s.name || s.branch, s.branch, s.base_branch || 'buffer']);

          streamIdMap.set(s.branch, streamId);
          createdStreams.push(result.rows[0]);
        }

        // Second pass: set parent_stream_id for dependency ordering
        for (const s of streams) {
          if (s.depends_on && s.depends_on.length > 0) {
            const parentBranch = s.depends_on[s.depends_on.length - 1]; // Last dependency
            const parentId = streamIdMap.get(parentBranch);
            if (parentId) {
              await client.query(`
                UPDATE gitswarm_streams SET parent_stream_id = $1 WHERE id = $2
              `, [parentId, streamIdMap.get(s.branch)]);
            }
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Create branches in Gitea (outside transaction — git operations are idempotent)
      for (const s of streams) {
        try {
          await backend.createBranch(repo_id, s.branch, s.base_branch || 'buffer');
        } catch {
          // Branch may already exist
        }
      }

      // Get clone URL
      let cloneUrl: string | undefined;
      try {
        const access = await backend.getCloneAccess(repo_id);
        cloneUrl = access.cloneUrl;
      } catch {
        // Non-fatal
      }

      emitGitSwarmEvent(GITSWARM_EVENTS.SWARM_CREATED, {
        task_id,
        stream_count: createdStreams.length,
        branches: createdStreams.map(s => s.branch),
      }, repo_id, agentId);

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
    },
  };
}

// ============================================================
// Shared service functions (used by both MAP handlers and REST)
// ============================================================

/**
 * Get detailed consensus state for a stream.
 * Shared by x-gitswarm/consensus/check, x-gitswarm/stream/review,
 * and GET /gitswarm/repos/:id/streams/:id/consensus.
 */
export async function checkConsensusDetailed(streamId: string, repoId: string): Promise<{
  reached: boolean;
  ratio: number;
  threshold: number;
  approvals: number;
  rejections: number;
  total_maintainers: number;
  votes: Array<{ reviewer_id: string; reviewer_name: string; verdict: string; reviewed_at: string }>;
}> {
  // Get repo consensus config
  const repoResult = await query(
    'SELECT consensus_threshold, min_reviews FROM gitswarm_repos WHERE id = $1',
    [repoId]
  );
  const threshold = parseFloat(repoResult.rows[0]?.consensus_threshold) || 0.66;
  const minReviews = parseInt(repoResult.rows[0]?.min_reviews) || 1;

  // Get reviews
  const reviews = await query(`
    SELECT r.reviewer_id, r.verdict, r.reviewed_at, a.name as reviewer_name
    FROM gitswarm_stream_reviews r
    LEFT JOIN agents a ON r.reviewer_id = a.id
    WHERE r.stream_id = $1
  `, [streamId]);

  // Get maintainer count
  const maintainers = await query(
    'SELECT COUNT(*) as count FROM gitswarm_maintainers WHERE repo_id = $1',
    [repoId]
  );
  const totalMaintainers = parseInt(maintainers.rows[0]?.count) || 1;

  const approvals = reviews.rows.filter((r: any) => r.verdict === 'approve').length;
  const rejections = reviews.rows.filter((r: any) => r.verdict === 'request_changes').length;
  const ratio = totalMaintainers > 0 ? approvals / totalMaintainers : 0;
  const reached = ratio >= threshold && approvals >= minReviews;

  return {
    reached,
    ratio,
    threshold,
    approvals,
    rejections,
    total_maintainers: totalMaintainers,
    votes: reviews.rows.map((r: any) => ({
      reviewer_id: r.reviewer_id,
      reviewer_name: r.reviewer_name,
      verdict: r.verdict,
      reviewed_at: r.reviewed_at,
    })),
  };
}
