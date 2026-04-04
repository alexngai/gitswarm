/**
 * GitHub-Compatible Repos Endpoints
 *
 * GET /repos/:owner/:repo — repo metadata in GitHub shape
 * GET /repos/:owner/:repo/branches — passthrough to Gitea
 * GET /repos/:owner/:repo/collaborators — repo maintainers
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { githubCompatAuth, resolveRepoFromParams } from './index.js';
import { config } from '../../config/env.js';

export async function reposRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /repos/:owner/:repo
   * Returns repository metadata in GitHub-compatible shape.
   */
  app.get('/repos/:owner/:repo', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const repoRecord = await resolveRepoFromParams(owner, repoName);

    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    return formatRepoResponse(repoRecord, owner);
  });

  /**
   * GET /repos/:owner/:repo/branches
   * Passthrough to Gitea — returns branch list.
   */
  app.get('/repos/:owner/:repo/branches', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const repoRecord = await resolveRepoFromParams(owner, repoName);

    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const giteaOwner = repoRecord.gitea_owner || owner;
    const giteaRepo = repoRecord.gitea_repo_name || repoName;
    const giteaUrl = config.gitea.url;

    if (!giteaUrl) {
      return reply.status(503).send({ message: 'Gitea not configured' });
    }

    const res = await fetch(
      `${giteaUrl}/api/v1/repos/${encodeURIComponent(giteaOwner)}/${encodeURIComponent(giteaRepo)}/branches`,
      {
        headers: { 'Authorization': `token ${config.gitea.adminToken}` },
      }
    );

    if (!res.ok) {
      return reply.status(res.status).send({ message: 'Failed to fetch branches' });
    }

    const branches = await res.json() as Array<Record<string, any>>;
    return branches.map(b => ({
      name: b.name,
      commit: {
        sha: b.commit?.id,
        url: b.commit?.url,
      },
      protected: b.protected || false,
    }));
  });

  /**
   * GET /repos/:owner/:repo/collaborators
   * Returns repo maintainers as GitHub collaborators.
   */
  app.get('/repos/:owner/:repo/collaborators', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const repoRecord = await resolveRepoFromParams(owner, repoName);

    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const maintainers = await query(`
      SELECT a.id, a.name, a.avatar_url, m.role
      FROM gitswarm_maintainers m
      JOIN agents a ON m.agent_id = a.id
      WHERE m.repo_id = $1
    `, [repoRecord.id]);

    return maintainers.rows.map(m => ({
      login: m.name,
      id: m.id,
      avatar_url: m.avatar_url,
      type: 'Bot',
      permissions: {
        admin: m.role === 'owner',
        maintain: m.role === 'owner' || m.role === 'maintainer',
        push: true,
        pull: true,
      },
    }));
  });
}

function formatRepoResponse(repo: Record<string, any>, owner: string) {
  return {
    id: repo.id,
    name: repo.gitea_repo_name || repo.github_repo_name || repo.name,
    full_name: `${owner}/${repo.gitea_repo_name || repo.github_repo_name || repo.name}`,
    owner: {
      login: owner,
      id: repo.org_id,
      type: 'Organization',
    },
    private: repo.is_private || false,
    description: repo.description || '',
    default_branch: repo.default_branch || 'main',
    language: repo.primary_language,
    archived: repo.is_archived || false,
    // GitSwarm-specific extensions
    gitswarm: {
      stage: repo.stage,
      ownership_model: repo.ownership_model,
      consensus_threshold: repo.consensus_threshold,
      merge_mode: repo.merge_mode,
      buffer_branch: repo.buffer_branch,
      git_backend: repo.git_backend,
    },
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}
