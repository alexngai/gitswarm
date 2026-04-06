/**
 * Internal Git Hooks API
 *
 * Endpoints called by server-side git hooks (pre-receive, post-receive)
 * installed in Gitea repositories. Authenticated via X-Internal-Secret header.
 *
 * These enforce governance at the git protocol level — even if an agent
 * bypasses the GitSwarm API and pushes directly via git, governance rules
 * are enforced by the pre-receive hook.
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { config } from '../../config/env.js';

interface PreReceiveBody {
  repo_path: string;
  ref: string;
  old_sha: string;
  new_sha: string;
  pusher: string;
}

interface PostReceiveBody {
  repo_path: string;
  ref: string;
  old_sha: string;
  new_sha: string;
  pusher: string;
}

interface PreReceiveResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Authenticate internal hook requests via shared secret.
 */
function verifyInternalSecret(request: any, reply: any): void {
  const secret = request.headers['x-internal-secret'];
  const expected = config.gitea.internalSecret;

  if (!expected) {
    // No secret configured — allow all (development mode)
    return;
  }

  if (secret !== expected) {
    reply.status(403).send({ error: 'Invalid internal secret' });
  }
}

/**
 * Resolve a GitSwarm repo from a Gitea repo path.
 * Gitea repo paths look like: /data/gitea-repositories/{owner}/{repo}.git
 */
async function resolveRepoFromPath(repoPath: string): Promise<Record<string, any> | null> {
  // Extract owner/repo from path
  // e.g., /data/gitea-repositories/my-org/my-repo.git → my-org / my-repo
  const match = repoPath.match(/\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;

  const [, owner, repoName] = match;

  const result = await query(`
    SELECT r.id, r.name, r.default_branch, r.buffer_branch, r.promote_target,
           r.merge_mode, r.git_backend, r.gitea_owner, r.gitea_repo_name,
           o.id as org_id
    FROM gitswarm_repos r
    JOIN gitswarm_orgs o ON r.org_id = o.id
    WHERE r.gitea_owner = $1 AND r.gitea_repo_name = $2 AND r.status = 'active'
  `, [owner, repoName]);

  return result.rows[0] || null;
}

/**
 * Resolve a Gitea username to a GitSwarm agent ID.
 */
async function resolveAgentFromPusher(pusher: string): Promise<string | null> {
  const result = await query(`
    SELECT agent_id FROM gitswarm_agent_gitea_users WHERE gitea_username = $1
  `, [pusher]);
  return result.rows[0]?.agent_id || null;
}

/**
 * Check if a ref is a protected branch (main, default, promote_target).
 */
function isProtectedBranch(repo: Record<string, any>, ref: string): boolean {
  const branchName = ref.replace('refs/heads/', '');
  const protectedBranches = new Set([
    repo.default_branch || 'main',
    repo.promote_target || 'main',
  ]);
  return protectedBranches.has(branchName);
}

/**
 * Check if a ref is the buffer branch.
 */
function isBufferBranch(repo: Record<string, any>, ref: string): boolean {
  const branchName = ref.replace('refs/heads/', '');
  return branchName === (repo.buffer_branch || 'buffer');
}

/**
 * Check if a ref is a stream branch (convention: stream/* prefix).
 */
function isStreamBranch(ref: string): boolean {
  const branchName = ref.replace('refs/heads/', '');
  return branchName.startsWith('stream/');
}

/**
 * Validate a push against governance rules.
 */
async function validatePreReceive(body: PreReceiveBody): Promise<PreReceiveResult> {
  const { repo_path, ref, old_sha, new_sha, pusher } = body;

  // Skip tag pushes — only enforce on branch pushes
  if (!ref.startsWith('refs/heads/')) {
    return { allowed: true };
  }

  // Resolve repo
  const repo = await resolveRepoFromPath(repo_path);
  if (!repo) {
    // Repo not tracked by GitSwarm — allow all pushes
    return { allowed: true };
  }

  // Resolve pusher to agent
  const agentId = await resolveAgentFromPusher(pusher);

  // ============================================================
  // Rule 1: Protected branches (main, promote_target)
  // Only allow pushes that match a pending merge record.
  // ============================================================
  if (isProtectedBranch(repo, ref)) {
    const pendingMerge = await query(`
      SELECT id, stream_id FROM gitswarm_pending_merges
      WHERE repo_id = $1 AND status = 'pending' AND expires_at > NOW()
    `, [repo.id]);

    if (pendingMerge.rows.length === 0) {
      return {
        allowed: false,
        reason: `Direct push to protected branch '${ref.replace('refs/heads/', '')}' denied. Use a stream and merge through governance.`,
      };
    }

    // Mark the pending merge as completed
    await query(`
      UPDATE gitswarm_pending_merges SET status = 'completed'
      WHERE repo_id = $1 AND status = 'pending'
    `, [repo.id]);

    return { allowed: true };
  }

  // ============================================================
  // Rule 2: Buffer branch
  // Only accepts pushes from governance-approved merges.
  // ============================================================
  if (isBufferBranch(repo, ref)) {
    const pendingMerge = await query(`
      SELECT id, stream_id FROM gitswarm_pending_merges
      WHERE repo_id = $1 AND status = 'pending' AND expires_at > NOW()
    `, [repo.id]);

    if (pendingMerge.rows.length === 0) {
      return {
        allowed: false,
        reason: `Buffer branch '${repo.buffer_branch || 'buffer'}' only accepts consensus-approved merges.`,
      };
    }

    await query(`
      UPDATE gitswarm_pending_merges SET status = 'completed'
      WHERE repo_id = $1 AND status = 'pending'
    `, [repo.id]);

    return { allowed: true };
  }

  // ============================================================
  // Rule 3: Stream branches (stream/*)
  // Only the owning agent or maintainers can push.
  // ============================================================
  if (isStreamBranch(ref)) {
    const branchName = ref.replace('refs/heads/', '');

    const stream = await query(`
      SELECT id, agent_id FROM gitswarm_streams
      WHERE repo_id = $1 AND branch = $2 AND status != 'abandoned'
    `, [repo.id, branchName]);

    if (stream.rows.length > 0 && agentId) {
      const streamOwner = stream.rows[0].agent_id;

      if (streamOwner && streamOwner !== agentId) {
        // Check if pusher is a maintainer
        const maintainer = await query(`
          SELECT id FROM gitswarm_maintainers
          WHERE repo_id = $1 AND agent_id = $2
        `, [repo.id, agentId]);

        if (maintainer.rows.length === 0) {
          return {
            allowed: false,
            reason: `Only the stream owner or maintainers can push to '${branchName}'.`,
          };
        }
      }
    }

    return { allowed: true };
  }

  // ============================================================
  // Default: allow pushes to non-governed branches
  // ============================================================
  return { allowed: true };
}

export async function internalGitHookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /internal/git/pre-receive
   *
   * Called by the pre-receive hook before Gitea accepts a push.
   * Returns { allowed: true } or { allowed: false, reason: "..." }.
   */
  app.post('/internal/git/pre-receive', {
    preHandler: [verifyInternalSecret],
    schema: {
      body: {
        type: 'object',
        required: ['repo_path', 'ref', 'old_sha', 'new_sha', 'pusher'],
        properties: {
          repo_path: { type: 'string' },
          ref: { type: 'string' },
          old_sha: { type: 'string' },
          new_sha: { type: 'string' },
          pusher: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as PreReceiveBody;

    app.log.info({
      ref: body.ref,
      pusher: body.pusher,
      repo_path: body.repo_path,
    }, 'Pre-receive hook called');

    try {
      const result = await validatePreReceive(body);

      if (!result.allowed) {
        app.log.warn({ ref: body.ref, reason: result.reason }, 'Pre-receive: push denied');
      }

      return result;
    } catch (error) {
      app.log.error({ error: (error as Error).message }, 'Pre-receive hook error');
      // On error, allow the push (fail-open) to avoid blocking all git operations
      // if GitSwarm is having issues
      return { allowed: true, reason: 'Internal error — failing open' };
    }
  });

  /**
   * POST /internal/git/post-receive
   *
   * Called by the post-receive hook after a push is accepted.
   * Used for fast event propagation (supplements Gitea webhooks).
   * Always returns 200 — this is fire-and-forget.
   */
  app.post('/internal/git/post-receive', {
    preHandler: [verifyInternalSecret],
    schema: {
      body: {
        type: 'object',
        required: ['repo_path', 'ref', 'new_sha', 'pusher'],
        properties: {
          repo_path: { type: 'string' },
          ref: { type: 'string' },
          old_sha: { type: 'string' },
          new_sha: { type: 'string' },
          pusher: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as PostReceiveBody;

    app.log.info({
      ref: body.ref,
      pusher: body.pusher,
      new_sha: body.new_sha,
    }, 'Post-receive hook called');

    try {
      const repo = await resolveRepoFromPath(body.repo_path);
      if (!repo) return { received: true };

      const agentId = await resolveAgentFromPusher(body.pusher);
      const branchName = body.ref.replace('refs/heads/', '');

      // Record push event in activity log
      await query(`
        INSERT INTO activity_log (agent_id, event_type, target_type, target_id, metadata)
        VALUES ($1, 'git_push', 'gitswarm_repo', $2, $3)
      `, [
        agentId,
        repo.id,
        JSON.stringify({
          ref: body.ref,
          branch: branchName,
          new_sha: body.new_sha,
          old_sha: body.old_sha,
          pusher: body.pusher,
        }),
      ]);

      // If push is to a stream branch, update stream's updated_at
      if (isStreamBranch(body.ref)) {
        await query(`
          UPDATE gitswarm_streams SET updated_at = NOW()
          WHERE repo_id = $1 AND branch = $2 AND status != 'abandoned'
        `, [repo.id, branchName]);
      }
    } catch (error) {
      // Non-fatal — log and continue
      app.log.error({ error: (error as Error).message }, 'Post-receive hook error');
    }

    return { received: true };
  });
}

// Export helpers for testing
export {
  resolveRepoFromPath,
  resolveAgentFromPusher,
  isProtectedBranch,
  isBufferBranch,
  isStreamBranch,
  validatePreReceive,
};
