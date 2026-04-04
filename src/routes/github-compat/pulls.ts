/**
 * GitHub-Compatible Pull Requests Endpoints
 *
 * The core translation layer: Pull Requests = GitSwarm Streams.
 *
 * GET  /repos/:owner/:repo/pulls       — list streams as PRs
 * POST /repos/:owner/:repo/pulls       — create stream (governance-enabled PR)
 * GET  /repos/:owner/:repo/pulls/:number — get stream by stream_number
 * POST /repos/:owner/:repo/pulls/:number/reviews — submit consensus vote
 * PUT  /repos/:owner/:repo/pulls/:number/merge — governance-gated merge
 */
import type { FastifyInstance } from 'fastify';
import { query, getClient } from '../../config/database.js';
import { githubCompatAuth, resolveRepoFromParams, mapStreamStatusToGitHubState } from './index.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

const permissionService = new GitSwarmPermissionService();

export async function pullsRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /repos/:owner/:repo/pulls
   * List streams as GitHub PRs.
   */
  app.get('/repos/:owner/:repo/pulls', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { state = 'open', per_page = 30, page = 1 } = request.query as Record<string, any>;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Map GitHub state to GitSwarm status
    let statusFilter: string[];
    switch (state) {
      case 'open': statusFilter = ['active', 'in_review']; break;
      case 'closed': statusFilter = ['merged', 'abandoned']; break;
      case 'all': statusFilter = ['active', 'in_review', 'merged', 'abandoned']; break;
      default: statusFilter = ['active', 'in_review'];
    }

    const limit = Math.min(parseInt(per_page) || 30, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const streams = await query(`
      SELECT s.*, a.name as agent_name, a.avatar_url as agent_avatar
      FROM gitswarm_streams s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.repo_id = $1 AND s.status = ANY($2)
      ORDER BY s.created_at DESC
      LIMIT $3 OFFSET $4
    `, [repoRecord.id, statusFilter, limit, offset]);

    return streams.rows.map(s => formatPullResponse(s, owner, repoName));
  });

  /**
   * POST /repos/:owner/:repo/pulls
   * Create a stream (governance-enabled PR).
   */
  app.post('/repos/:owner/:repo/pulls', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { title, body, head, base } = request.body as { title: string; body?: string; head: string; base?: string };
    const agent = (request as any).agent;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Generate stream ID
    const crypto = await import('crypto');
    const streamId = crypto.randomUUID();

    const result = await query(`
      INSERT INTO gitswarm_streams (
        id, repo_id, agent_id, name, branch, base_branch, source, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'github_compat', 'active')
      RETURNING *
    `, [streamId, repoRecord.id, agent.id, title, head, base || repoRecord.default_branch || 'main']);

    const stream = result.rows[0];

    reply.status(201);
    return formatPullResponse({
      ...stream,
      agent_name: agent.name,
      description: body,
    }, owner, repoName);
  });

  /**
   * GET /repos/:owner/:repo/pulls/:number
   * Get a single stream by stream_number.
   */
  app.get('/repos/:owner/:repo/pulls/:number', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName, number: prNumber } = request.params as { owner: string; repo: string; number: string };

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const stream = await query(`
      SELECT s.*, a.name as agent_name, a.avatar_url as agent_avatar
      FROM gitswarm_streams s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.repo_id = $1 AND s.stream_number = $2
    `, [repoRecord.id, parseInt(prNumber)]);

    if (stream.rows.length === 0) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const s = stream.rows[0];

    // Get consensus state
    let consensus: any = null;
    try {
      consensus = await permissionService.checkConsensus(s.id, repoRecord.id);
    } catch {
      // Ignore — consensus check may fail for new streams
    }

    return {
      ...formatPullResponse(s, owner, repoName),
      mergeable: consensus?.reached || false,
      // GitSwarm extension
      gitswarm: {
        consensus,
        stream_id: s.id,
        review_status: s.review_status,
      },
    };
  });

  /**
   * POST /repos/:owner/:repo/pulls/:number/reviews
   * Submit a review → maps to GitSwarm consensus vote.
   */
  app.post('/repos/:owner/:repo/pulls/:number/reviews', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName, number: prNumber } = request.params as { owner: string; repo: string; number: string };
    const { event, body: reviewBody } = request.body as { event: string; body?: string };
    const agent = (request as any).agent;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Find stream by stream_number
    const streamResult = await query(`
      SELECT id, status FROM gitswarm_streams
      WHERE repo_id = $1 AND stream_number = $2
    `, [repoRecord.id, parseInt(prNumber)]);

    if (streamResult.rows.length === 0) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const stream = streamResult.rows[0];

    // Map GitHub review event to GitSwarm verdict
    let verdict: string;
    switch (event?.toUpperCase()) {
      case 'APPROVE': verdict = 'approve'; break;
      case 'REQUEST_CHANGES': verdict = 'request_changes'; break;
      case 'COMMENT': verdict = 'comment'; break;
      default: verdict = 'comment';
    }

    // Only insert actual reviews (approve/request_changes), not comments
    if (verdict !== 'comment') {
      await query(`
        INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
          verdict = $3, feedback = $4, reviewed_at = NOW()
      `, [stream.id, agent.id, verdict, reviewBody || '']);

      // If stream is active, move to in_review
      if (stream.status === 'active') {
        await query(`
          UPDATE gitswarm_streams SET status = 'in_review', updated_at = NOW()
          WHERE id = $1 AND status = 'active'
        `, [stream.id]);
      }
    }

    reply.status(200);
    return {
      id: stream.id,
      user: { login: agent.name, id: agent.id },
      state: event?.toUpperCase() || 'COMMENTED',
      body: reviewBody || '',
      submitted_at: new Date().toISOString(),
    };
  });

  /**
   * PUT /repos/:owner/:repo/pulls/:number/merge
   * Governance-gated merge. Returns 405 if consensus not reached.
   */
  app.put('/repos/:owner/:repo/pulls/:number/merge', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName, number: prNumber } = request.params as { owner: string; repo: string; number: string };
    const { merge_method = 'merge', commit_message } = request.body as Record<string, any> || {};
    const agent = (request as any).agent;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Find stream
    const streamResult = await query(`
      SELECT id, status, branch FROM gitswarm_streams
      WHERE repo_id = $1 AND stream_number = $2
    `, [repoRecord.id, parseInt(prNumber)]);

    if (streamResult.rows.length === 0) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const stream = streamResult.rows[0];

    if (stream.status === 'merged') {
      return reply.status(405).send({
        message: 'Pull Request already merged',
      });
    }

    if (stream.status === 'abandoned') {
      return reply.status(405).send({
        message: 'Pull Request is closed',
      });
    }

    // Check consensus
    const consensus = await permissionService.checkConsensus(stream.id, repoRecord.id);
    if (!consensus.reached) {
      return reply.status(405).send({
        message: 'Consensus not reached. Required approvals not met.',
        documentation_url: 'https://docs.gitswarm.dev/consensus',
        // GitSwarm extension: consensus details
        consensus: {
          threshold: consensus.threshold,
          current_ratio: consensus.ratio,
          approvals: consensus.approvals,
          rejections: consensus.rejections,
        },
      });
    }

    // Execute merge via transaction
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Record pending merge for pre-receive hook
      await client.query(`
        INSERT INTO gitswarm_pending_merges (repo_id, stream_id, status, expires_at)
        VALUES ($1, $2, 'pending', NOW() + INTERVAL '5 minutes')
      `, [repoRecord.id, stream.id]);

      // Record merge
      await client.query(`
        INSERT INTO gitswarm_merges (repo_id, stream_id, agent_id, target_branch)
        VALUES ($1, $2, $3, $4)
      `, [repoRecord.id, stream.id, agent.id, repoRecord.buffer_branch || 'buffer']);

      // Update stream status
      const mergeResult = await client.query(`
        UPDATE gitswarm_streams SET status = 'merged', review_status = 'approved', updated_at = NOW()
        WHERE id = $1 AND status IN ('active', 'in_review')
        RETURNING *
      `, [stream.id]);

      if (mergeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ message: 'Merge conflict — stream status changed' });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      merged: true,
      message: commit_message || `Merge stream ${stream.branch}`,
    };
  });
}

/**
 * Format a GitSwarm stream as a GitHub PR response.
 */
function formatPullResponse(stream: Record<string, any>, owner: string, repoName: string) {
  const state = mapStreamStatusToGitHubState(stream.status);
  return {
    number: stream.stream_number,
    state,
    title: stream.name || stream.branch,
    body: stream.description || stream.metadata?.body || '',
    head: {
      ref: stream.branch,
      label: `${owner}:${stream.branch}`,
    },
    base: {
      ref: stream.base_branch || 'main',
      label: `${owner}:${stream.base_branch || 'main'}`,
    },
    user: {
      login: stream.agent_name || 'unknown',
      id: stream.agent_id,
      avatar_url: stream.agent_avatar,
      type: 'Bot',
    },
    merged: stream.status === 'merged',
    created_at: stream.created_at,
    updated_at: stream.updated_at,
    html_url: stream.gitea_pr_url || `${owner}/${repoName}/pulls/${stream.stream_number}`,
    // GitSwarm extensions (non-standard, but useful for GitSwarm-aware clients)
    gitswarm_stream_id: stream.id,
    gitswarm_status: stream.status,
    gitswarm_review_status: stream.review_status,
  };
}
