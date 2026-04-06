/**
 * Mirror Management Routes
 *
 * Manages GitHub ↔ Gitea mirroring. Three modes:
 *   - pull:  GitHub → Gitea (import, periodic sync)
 *   - push:  Gitea → GitHub (read-only mirror on GitHub)
 *   - bidirectional: both directions (transition period)
 *
 * Leverages Gitea's built-in mirror support.
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { giteaAdmin } from '../../services/gitea-admin.js';
import { config } from '../../config/env.js';

const rateLimit = createRateLimiter('gitswarm_write');

export async function mirrorRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService } = options;

  /**
   * POST /gitswarm/repos/:repoId/mirrors
   * Create a mirror configuration.
   */
  app.post('/gitswarm/repos/:repoId/mirrors', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['github_url', 'direction'],
        properties: {
          github_url: { type: 'string' },
          direction: { type: 'string', enum: ['pull', 'push', 'bidirectional'] },
          github_token: { type: 'string' },
          sync_interval: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { github_url, direction, github_token, sync_interval } = request.body as {
      github_url: string;
      direction: 'pull' | 'push' | 'bidirectional';
      github_token?: string;
      sync_interval?: string;
    };

    // Get repo
    const repoResult = await query(`
      SELECT id, gitea_owner, gitea_repo_name, git_backend, name
      FROM gitswarm_repos WHERE id = $1 AND status = 'active'
    `, [repoId]);

    if (repoResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const repo = repoResult.rows[0];

    if (!giteaAdmin.isConfigured) {
      return reply.status(503).send({ error: 'Gitea not configured' });
    }

    const results: Record<string, any> = { direction };

    try {
      // Pull mirror: GitHub → Gitea
      if (direction === 'pull' || direction === 'bidirectional') {
        if (!repo.gitea_owner) {
          // Repo doesn't exist in Gitea yet — import it
          const orgResult = await query(`
            SELECT o.gitea_org_name, o.github_org_name
            FROM gitswarm_orgs o
            JOIN gitswarm_repos r ON r.org_id = o.id
            WHERE r.id = $1
          `, [repoId]);

          const orgName = orgResult.rows[0]?.gitea_org_name || orgResult.rows[0]?.github_org_name;
          if (!orgName) {
            return reply.status(400).send({ error: 'Cannot determine organization for mirror' });
          }

          await giteaAdmin.ensureOrg(orgName);

          const mirrored = await giteaAdmin.mirrorFromGitHub(
            github_url, orgName, repo.name,
            { githubToken: github_token, mirror: true }
          );

          // Update repo with Gitea info
          await query(`
            UPDATE gitswarm_repos
            SET gitea_repo_id = $1, gitea_owner = $2, gitea_repo_name = $3,
                gitea_url = $4, git_backend = 'gitea'
            WHERE id = $5
          `, [mirrored.id, orgName, mirrored.name, mirrored.html_url, repoId]);

          results.pull_mirror = { status: 'created', gitea_repo: mirrored.full_name };
        } else {
          results.pull_mirror = { status: 'skipped', reason: 'Repo already in Gitea' };
        }
      }

      // Push mirror: Gitea → GitHub
      if (direction === 'push' || direction === 'bidirectional') {
        if (!repo.gitea_owner || !repo.gitea_repo_name) {
          return reply.status(400).send({
            error: 'Repo must exist in Gitea before creating a push mirror',
          });
        }

        if (!github_token) {
          return reply.status(400).send({
            error: 'github_token is required for push mirrors',
          });
        }

        const pushMirror = await giteaAdmin.createPushMirror(
          repo.gitea_owner,
          repo.gitea_repo_name,
          github_url,
          github_token,
          sync_interval
        );

        results.push_mirror = { status: 'created', mirror: pushMirror };
      }
    } catch (error) {
      return reply.status(500).send({
        error: 'Mirror creation failed',
        message: (error as Error).message,
      });
    }

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: (request as any).agent.id,
        event_type: 'mirror_created',
        target_type: 'gitswarm_repo',
        target_id: repoId,
        metadata: { direction, github_url },
      }).catch((err: any) => console.error('Failed to log mirror activity:', err));
    }

    reply.status(201);
    return { mirror: results };
  });

  /**
   * GET /gitswarm/repos/:repoId/mirrors
   * Get mirror status for a repo.
   */
  app.get('/gitswarm/repos/:repoId/mirrors', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { repoId } = request.params as { repoId: string };

    const repoResult = await query(`
      SELECT id, gitea_owner, gitea_repo_name, git_backend
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repoResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const repo = repoResult.rows[0];
    const mirrors: Record<string, any> = { push_mirrors: [], is_pull_mirror: false };

    if (repo.gitea_owner && repo.gitea_repo_name && giteaAdmin.isConfigured) {
      try {
        // Check if repo is a pull mirror
        const giteaRepo = await giteaAdmin.getRepo(repo.gitea_owner, repo.gitea_repo_name);
        mirrors.is_pull_mirror = (giteaRepo as any)?.mirror || false;

        // Get push mirrors
        const giteaUrl = config.gitea.url;
        const res = await fetch(
          `${giteaUrl}/api/v1/repos/${encodeURIComponent(repo.gitea_owner)}/${encodeURIComponent(repo.gitea_repo_name)}/push-mirrors`,
          { headers: { 'Authorization': `token ${config.gitea.adminToken}` } }
        );

        if (res.ok) {
          mirrors.push_mirrors = await res.json();
        }
      } catch {
        // Gitea may not support push mirrors API in all versions
      }
    }

    return { mirrors };
  });

  /**
   * DELETE /gitswarm/repos/:repoId/mirrors/:mirrorId
   * Remove a push mirror.
   */
  app.delete('/gitswarm/repos/:repoId/mirrors/:mirrorId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId, mirrorId } = request.params as { repoId: string; mirrorId: string };

    const repoResult = await query(`
      SELECT gitea_owner, gitea_repo_name FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repoResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    const repo = repoResult.rows[0];

    if (!repo.gitea_owner || !giteaAdmin.isConfigured) {
      return reply.status(400).send({ error: 'No Gitea repo configured' });
    }

    try {
      const giteaUrl = config.gitea.url;
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/${encodeURIComponent(repo.gitea_owner)}/${encodeURIComponent(repo.gitea_repo_name)}/push-mirrors/${mirrorId}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `token ${config.gitea.adminToken}` },
        }
      );

      if (!res.ok && res.status !== 404) {
        return reply.status(res.status).send({ error: 'Failed to delete mirror' });
      }
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }

    return reply.status(204).send();
  });
}
