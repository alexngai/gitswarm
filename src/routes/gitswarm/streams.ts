import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, getClient } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';
import { StageProgressionService } from '../../services/stage-progression.js';

const permissionService = new GitSwarmPermissionService();
const stageService = new StageProgressionService();

export async function streamRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService, pluginEngine } = options;

  const rateLimitRead = createRateLimiter('gitswarm_read');
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  /**
   * Emit a gitswarm event through the plugin engine (fire-and-forget).
   */
  function emitGitswarmEvent(repoId, eventType, payload) {
    if (!pluginEngine) return;
    pluginEngine.processGitswarmEvent(repoId, eventType, payload)
      .catch(err => console.error(`Gitswarm event ${eventType} failed:`, err.message));
  }

  // ============================================================
  // Stream CRUD
  // ============================================================

  // Create a stream (from CLI sync or API call)
  app.post('/gitswarm/repos/:repoId/streams', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          branch: { type: 'string' },
          agent_id: { type: 'string' },
          source: { type: 'string', enum: ['cli', 'api', 'github_pr'] },
          parent_stream_id: { type: 'string' },
          base_branch: { type: 'string' },
          github_pr_number: { type: 'integer' },
          github_pr_url: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const agentId = (request.body as any).agent_id || request.agent.id;

    // Check write permission
    const perm = await permissionService.canPerform(agentId, repoId, 'write');
    if (!perm.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    const {
      id, name, branch, source = 'api',
      parent_stream_id, base_branch,
      github_pr_number, github_pr_url,
    } = (request.body as any);

    const result = await query(`
      INSERT INTO gitswarm_streams (
        id, repo_id, agent_id, name, branch, source,
        parent_stream_id, base_branch,
        github_pr_number, github_pr_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, gitswarm_streams.name),
        branch = COALESCE(EXCLUDED.branch, gitswarm_streams.branch),
        updated_at = NOW()
      RETURNING *
    `, [id, repoId, agentId, name, branch, source,
        parent_stream_id, base_branch,
        github_pr_number, github_pr_url]);

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'stream_created',
        target_type: 'stream',
        target_id: id,
        metadata: { repo_id: repoId, name, source },
      });
    }

    return reply.status(201).send({ stream: result.rows[0] });
  });

  // List streams for a repo
  app.get('/gitswarm/repos/:repoId/streams', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const { status, agent_id, limit: rawLimit, offset: rawOffset } = (request.query as any);
    const limit = Math.min(parseInt(rawLimit) || 50, 100);
    const offset = parseInt(rawOffset) || 0;

    let sql = `
      SELECT s.*, a.name as agent_name
      FROM gitswarm_streams s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.repo_id = $1
    `;
    const params = [repoId];
    let paramIdx = 2;

    if (status) {
      sql += ` AND s.status = $${paramIdx++}`;
      params.push(status);
    }
    if (agent_id) {
      sql += ` AND s.agent_id = $${paramIdx++}`;
      params.push(agent_id);
    }

    sql += ` ORDER BY s.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    const countResult = await query(`
      SELECT COUNT(*) as total FROM gitswarm_streams WHERE repo_id = $1
    `, [repoId]);

    return {
      streams: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    };
  });

  // Get stream details
  app.get('/gitswarm/repos/:repoId/streams/:streamId', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);

    const result = await query(`
      SELECT s.*, a.name as agent_name
      FROM gitswarm_streams s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.id = $1 AND s.repo_id = $2
    `, [streamId, repoId]);

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    const stream = result.rows[0];

    // Get commits for this stream
    const commits = await query(`
      SELECT sc.*, a.name as agent_name
      FROM gitswarm_stream_commits sc
      LEFT JOIN agents a ON sc.agent_id = a.id
      WHERE sc.stream_id = $1
      ORDER BY sc.created_at DESC
    `, [streamId]);

    // Get reviews
    const reviews = await query(`
      SELECT sr.*, a.name as reviewer_name
      FROM gitswarm_stream_reviews sr
      LEFT JOIN agents a ON sr.reviewer_id = a.id
      WHERE sr.stream_id = $1
      ORDER BY sr.reviewed_at DESC
    `, [streamId]);

    return {
      stream,
      commits: commits.rows,
      reviews: reviews.rows,
    };
  });

  // Update stream status (abandon, etc.)
  app.patch('/gitswarm/repos/:repoId/streams/:streamId', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'in_review', 'merged', 'abandoned'] },
          review_status: { type: 'string', enum: ['in_review', 'approved', 'changes_requested'] },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const { status, review_status } = (request.body as any);

    // BUG-8 fix: Validate state machine transitions
    if (status) {
      const currentStream = await query(`
        SELECT status FROM gitswarm_streams WHERE id = $1 AND repo_id = $2
      `, [streamId, repoId]);

      if (currentStream.rows.length === 0) {
        return reply.status(404).send({ error: 'Stream not found' });
      }

      const validTransitions = {
        active: ['in_review', 'abandoned'],
        in_review: ['active', 'abandoned'],
        merged: [],
        abandoned: [],
        reverted: [],
      };

      const currentStatus = currentStream.rows[0].status;
      const allowed = validTransitions[currentStatus] || [];
      if (!allowed.includes(status)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Cannot transition from '${currentStatus}' to '${status}'`,
        });
      }
    }

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (status) {
      updates.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (review_status) {
      updates.push(`review_status = $${paramIdx++}`);
      params.push(review_status);
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    params.push(streamId, repoId);

    const result = await query(`
      UPDATE gitswarm_streams SET ${updates.join(', ')}
      WHERE id = $${paramIdx++} AND repo_id = $${paramIdx}
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    return { stream: result.rows[0] };
  });

  // Delete (abandon) a stream
  app.delete('/gitswarm/repos/:repoId/streams/:streamId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const agentId = request.agent.id;
    const { reason } = (request.query as any);

    // Verify stream exists and belongs to agent (or agent is maintainer)
    const stream = await query(`
      SELECT id, agent_id, status FROM gitswarm_streams
      WHERE id = $1 AND repo_id = $2
    `, [streamId, repoId]);

    if (stream.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    if (stream.rows[0].status === 'merged') {
      return reply.status(409).send({ error: 'Cannot abandon a merged stream' });
    }

    // Only stream owner or maintainer can abandon
    if (stream.rows[0].agent_id !== agentId) {
      const perm = await permissionService.canPerform(agentId, repoId, 'merge');
      if (!perm.allowed) {
        return reply.status(403).send({ error: 'Only stream owner or maintainer can abandon' });
      }
    }

    await query(`
      UPDATE gitswarm_streams SET status = 'abandoned', updated_at = NOW()
      WHERE id = $1
    `, [streamId]);

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'stream_abandoned',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId, reason },
      });
    }

    return { success: true, stream_id: streamId, status: 'abandoned' };
  });

  // Get diff for a stream (commits in stream not yet in base branch)
  app.get('/gitswarm/repos/:repoId/streams/:streamId/diff', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);

    const stream = await query(`
      SELECT s.*, r.buffer_branch
      FROM gitswarm_streams s
      JOIN gitswarm_repos r ON s.repo_id = r.id
      WHERE s.id = $1 AND s.repo_id = $2
    `, [streamId, repoId]);

    if (stream.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    const { buffer_branch, branch } = stream.rows[0];

    // Get commits in this stream
    const commits = await query(`
      SELECT sc.commit_hash, sc.change_id, sc.message, sc.created_at, a.name as agent_name
      FROM gitswarm_stream_commits sc
      LEFT JOIN agents a ON sc.agent_id = a.id
      WHERE sc.stream_id = $1
      ORDER BY sc.created_at ASC
    `, [streamId]);

    return {
      stream_id: streamId,
      branch: branch,
      base: buffer_branch,
      commits: commits.rows,
      commit_count: commits.rows.length,
    };
  });

  // ============================================================
  // Stream Commits
  // ============================================================

  // Record a commit on a stream
  app.post('/gitswarm/repos/:repoId/streams/:streamId/commits', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['commit_hash'],
        properties: {
          commit_hash: { type: 'string' },
          change_id: { type: 'string' },
          message: { type: 'string' },
          agent_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const agentId = (request.body as any).agent_id || request.agent.id;
    const { commit_hash, change_id, message } = (request.body as any);

    // Verify stream exists
    const stream = await query(`
      SELECT id FROM gitswarm_streams WHERE id = $1 AND repo_id = $2
    `, [streamId, repoId]);

    if (stream.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    const result = await query(`
      INSERT INTO gitswarm_stream_commits (stream_id, agent_id, commit_hash, change_id, message)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [streamId, agentId, commit_hash, change_id, message]);

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'commit',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId, commit_hash, message },
      });
    }

    return reply.status(201).send({ commit: result.rows[0] });
  });

  // ============================================================
  // Reviews & Consensus
  // ============================================================

  // Submit for review (changes stream status)
  app.post('/gitswarm/repos/:repoId/streams/:streamId/submit-review', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const agentId = request.agent.id;

    // BUG-6 fix: Prevent submitting streams with no commits
    const commits = await query(`
      SELECT COUNT(*) as count FROM gitswarm_stream_commits WHERE stream_id = $1
    `, [streamId]);

    if (parseInt(commits.rows[0]?.count ?? 0) === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot submit stream with no commits',
      });
    }

    const result = await query(`
      UPDATE gitswarm_streams SET
        status = 'in_review',
        review_status = 'in_review',
        updated_at = NOW()
      WHERE id = $1 AND repo_id = $2 AND status = 'active'
      RETURNING *
    `, [streamId, repoId]);

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found or not in active status' });
    }

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'submit_for_review',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId },
      });
    }

    return { stream: result.rows[0] };
  });

  // Submit a review on a stream
  app.post('/gitswarm/repos/:repoId/streams/:streamId/reviews', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
          feedback: { type: 'string' },
          is_human: { type: 'boolean' },
          tested: { type: 'boolean' },
          reviewer_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const reviewerId = (request.body as any).reviewer_id || request.agent.id;
    const { verdict, feedback = '', is_human = false, tested = false } = (request.body as any);

    // Verify stream exists and get author
    const stream = await query(`
      SELECT id, agent_id FROM gitswarm_streams WHERE id = $1 AND repo_id = $2
    `, [streamId, repoId]);

    if (stream.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    // BUG-1 fix: Prevent self-review (ported from patches.js)
    if (stream.rows[0].agent_id === reviewerId) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot review your own stream',
      });
    }

    const result = await query(`
      INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human, tested)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
        verdict = $3, feedback = $4, is_human = $5, tested = $6, reviewed_at = NOW()
      RETURNING *
    `, [streamId, reviewerId, verdict, feedback, is_human, tested]);

    // Update review_status on stream based on overall reviews
    if (verdict === 'request_changes') {
      await query(`
        UPDATE gitswarm_streams SET review_status = 'changes_requested', updated_at = NOW()
        WHERE id = $1
      `, [streamId]);
    }

    if (activityService) {
      await activityService.logActivity({
        agent_id: reviewerId,
        event_type: 'review_submitted',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId, verdict },
      });
    }

    return reply.status(201).send({ review: result.rows[0] });
  });

  // Check consensus for a stream
  app.get('/gitswarm/repos/:repoId/streams/:streamId/consensus', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId, streamId } = (request.params as any);
    return permissionService.checkConsensus(streamId, repoId);
  });

  // ============================================================
  // Merge request (approval check only — does NOT record a merge)
  // ============================================================

  app.post('/gitswarm/repos/:repoId/streams/:streamId/merge-request', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const agentId = request.agent.id;

    const repo = await query(`
      SELECT merge_mode, buffer_branch FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const { merge_mode, buffer_branch } = repo.rows[0];

    if (merge_mode === 'gated') {
      const perm = await permissionService.canPerform(agentId, repoId, 'merge');
      if (!perm.allowed) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Gated mode requires maintainer approval to merge',
        });
      }
    }

    if (merge_mode !== 'swarm') {
      const consensus = await permissionService.checkConsensus(streamId, repoId);
      if (!consensus.reached) {
        return reply.status(409).send({
          approved: false,
          consensus,
          bufferBranch: buffer_branch,
        });
      }
    }

    return {
      approved: true,
      bufferBranch: buffer_branch,
    };
  });

  // ============================================================
  // Merge completed (records actual merge — called after git merge)
  // ============================================================

  app.post('/gitswarm/repos/:repoId/streams/:streamId/merge', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          merge_commit: { type: 'string' },
          target_branch: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId, streamId } = (request.params as any);
    const agentId = request.agent.id;
    const { merge_commit, target_branch } = (request.body as any) || {};

    // BUG-5 fix: Check stream status before merge
    const streamCheck = await query(`
      SELECT status, parent_stream_id FROM gitswarm_streams WHERE id = $1 AND repo_id = $2
    `, [streamId, repoId]);

    if (streamCheck.rows.length === 0) {
      return reply.status(404).send({ error: 'Stream not found' });
    }

    if (streamCheck.rows[0].status === 'merged') {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Stream is already merged',
      });
    }

    if (streamCheck.rows[0].status !== 'in_review') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Cannot merge stream with status: ${streamCheck.rows[0].status}. Stream must be in_review.`,
      });
    }

    // BUG-17 fix: Check parent stream is merged (dependency enforcement)
    if (streamCheck.rows[0].parent_stream_id) {
      const parent = await query(`
        SELECT status FROM gitswarm_streams WHERE id = $1
      `, [streamCheck.rows[0].parent_stream_id]);

      if (parent.rows.length > 0 && parent.rows[0].status !== 'merged') {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Parent stream must be merged first',
        });
      }
    }

    // Check merge permission
    const repo = await query(`
      SELECT merge_mode, buffer_branch FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const { merge_mode, buffer_branch } = repo.rows[0];

    // In review/gated mode, check consensus first
    if (merge_mode !== 'swarm') {
      const consensus = await permissionService.checkConsensus(streamId, repoId);
      if (!consensus.reached) {
        return reply.status(409).send({
          error: 'Consensus not reached',
          consensus,
        });
      }
    }

    // In gated mode, require maintainer permission
    if (merge_mode === 'gated') {
      const perm = await permissionService.canPerform(agentId, repoId, 'merge');
      if (!perm.allowed) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Gated mode requires maintainer approval to merge',
        });
      }
    }

    // BUG-11 fix: Use transaction for atomic consensus-check + merge
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Record the merge
      await client.query(`
        INSERT INTO gitswarm_merges (repo_id, stream_id, agent_id, merge_commit, target_branch)
        VALUES ($1, $2, $3, $4, $5)
      `, [repoId, streamId, agentId, merge_commit, target_branch || buffer_branch]);

      // Update stream status with optimistic lock (only if still in_review)
      const mergeResult = await client.query(`
        UPDATE gitswarm_streams SET status = 'merged', review_status = 'approved', updated_at = NOW()
        WHERE id = $1 AND status = 'in_review'
        RETURNING *
      `, [streamId]);

      if (mergeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Stream status changed during merge (possible concurrent merge)',
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Update repo metrics (outside transaction — non-critical)
    await stageService.updateRepoMetrics(repoId);

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'stream_merged',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId, merge_commit, target_branch: target_branch || buffer_branch },
      });
    }

    return { success: true, stream_id: streamId, merged: true };
  });

  // ============================================================
  // Stabilization
  // ============================================================

  app.post('/gitswarm/repos/:repoId/stabilize', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['result'],
        properties: {
          result: { type: 'string', enum: ['green', 'red'] },
          tag: { type: 'string' },
          buffer_commit: { type: 'string' },
          breaking_stream_id: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const { result: stabResult, tag, buffer_commit, breaking_stream_id, details = {} } = (request.body as any);

    const perm = await permissionService.canPerform(request.agent.id, repoId, 'merge');
    if (!perm.allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const insertResult = await query(`
      INSERT INTO gitswarm_stabilizations (repo_id, result, tag, buffer_commit, breaking_stream_id, details)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [repoId, stabResult, tag, buffer_commit, breaking_stream_id, JSON.stringify(details)]);

    // If red and auto_revert_on_red, mark the breaking stream
    if (stabResult === 'red' && breaking_stream_id) {
      const repo = await query(`
        SELECT auto_revert_on_red FROM gitswarm_repos WHERE id = $1
      `, [repoId]);

      if (repo.rows[0]?.auto_revert_on_red) {
        await query(`
          UPDATE gitswarm_streams SET status = 'reverted', updated_at = NOW()
          WHERE id = $1
        `, [breaking_stream_id]);
      }
    }

    if (activityService) {
      await activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'stabilization',
        target_type: 'repo',
        target_id: repoId,
        metadata: { result: stabResult, tag, breaking_stream_id },
      });
    }

    // Emit gitswarm stabilization events
    const eventPayload = {
      tag,
      buffer_commit,
      details,
    };

    if (stabResult === 'green') {
      emitGitswarmEvent(repoId, 'stabilization_passed', eventPayload);
    } else if (stabResult === 'red') {
      emitGitswarmEvent(repoId, 'stabilization_failed', {
        ...eventPayload,
        breaking_stream_id,
      });
    }

    return reply.status(201).send({ stabilization: insertResult.rows[0] });
  });

  // ============================================================
  // Promotion
  // ============================================================

  app.post('/gitswarm/repos/:repoId/promote', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          from_commit: { type: 'string' },
          to_commit: { type: 'string' },
          triggered_by: { type: 'string', enum: ['auto', 'manual', 'council'] },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const agentId = request.agent.id;
    const { from_commit, to_commit, triggered_by = 'manual' } = (request.body as any) || {};

    // Require maintainer permission for manual promotion
    if (triggered_by === 'manual') {
      const perm = await permissionService.canPerform(agentId, repoId, 'merge');
      if (!perm.allowed) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    const repo = await query(`
      SELECT buffer_branch, promote_target FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const { buffer_branch, promote_target } = repo.rows[0];

    const result = await query(`
      INSERT INTO gitswarm_promotions (repo_id, from_branch, to_branch, from_commit, to_commit, triggered_by, agent_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [repoId, buffer_branch, promote_target, from_commit, to_commit, triggered_by, agentId]);

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'promote',
        target_type: 'repo',
        target_id: repoId,
        metadata: { from: buffer_branch, to: promote_target, triggered_by },
      });
    }

    return reply.status(201).send({
      promotion: result.rows[0],
      success: true,
      from: buffer_branch,
      to: promote_target,
    });
  });

  // Get stabilization history
  app.get('/gitswarm/repos/:repoId/stabilizations', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 20, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const result = await query(`
      SELECT s.*, bs.name as breaking_stream_name
      FROM gitswarm_stabilizations s
      LEFT JOIN gitswarm_streams bs ON s.breaking_stream_id = bs.id
      WHERE s.repo_id = $1
      ORDER BY s.stabilized_at DESC
      LIMIT $2 OFFSET $3
    `, [repoId, limit, offset]);

    return { stabilizations: result.rows };
  });

  // Get promotion history
  app.get('/gitswarm/repos/:repoId/promotions', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 20, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const result = await query(`
      SELECT p.*, a.name as agent_name
      FROM gitswarm_promotions p
      LEFT JOIN agents a ON p.agent_id = a.id
      WHERE p.repo_id = $1
      ORDER BY p.promoted_at DESC
      LIMIT $2 OFFSET $3
    `, [repoId, limit, offset]);

    return { promotions: result.rows };
  });

  // Get merge history
  app.get('/gitswarm/repos/:repoId/merges', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const result = await query(`
      SELECT m.*, a.name as agent_name, s.name as stream_name
      FROM gitswarm_merges m
      LEFT JOIN agents a ON m.agent_id = a.id
      LEFT JOIN gitswarm_streams s ON m.stream_id = s.id
      WHERE m.repo_id = $1
      ORDER BY m.merged_at DESC
      LIMIT $2 OFFSET $3
    `, [repoId, limit, offset]);

    return { merges: result.rows };
  });

  // ============================================================
  // Stream Activity Feed
  // ============================================================

  // Get stream lifecycle activity for a repo (WebSocket-compatible format)
  app.get('/gitswarm/repos/:repoId/stream-activity', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    if (activityService?.getStreamActivity) {
      const events = await activityService.getStreamActivity(repoId, { limit, offset });
      return { events };
    }

    // Fallback: query activity_log directly filtered by stream event types
    const streamTypes = [
      'stream_created', 'workspace_created', 'commit',
      'submit_for_review', 'review_submitted', 'stream_merged',
      'stream_abandoned', 'stabilization', 'promote',
    ];

    const result = await query(`
      SELECT al.*, a.name as agent_name
      FROM activity_log al
      LEFT JOIN agents a ON al.agent_id = a.id
      WHERE al.metadata->>'repo_id' = $1
        AND al.event_type = ANY($2)
      ORDER BY al.created_at DESC
      LIMIT $3 OFFSET $4
    `, [repoId, streamTypes, limit, offset]);

    return { events: result.rows };
  });

  // ============================================================
  // Repo Config (for CLI config pull)
  // ============================================================

  app.get('/gitswarm/repos/:repoId/config', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    const canRead = await permissionService.canPerform(request.agent.id, repoId, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const repo = await query(`
      SELECT merge_mode, ownership_model, consensus_threshold, min_reviews,
             human_review_weight, agent_access, min_karma, buffer_branch,
             promote_target, auto_promote_on_green, auto_revert_on_red,
             stabilize_command, plugins_enabled, stage
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    // Include config sync info if available
    const configSync = await query(`
      SELECT config_sha, plugins_sha, last_synced_at, sync_error
      FROM gitswarm_repo_config WHERE repo_id = $1
    `, [repoId]);

    return {
      config: repo.rows[0],
      config_sync: configSync.rows[0] || null,
    };
  });
}
