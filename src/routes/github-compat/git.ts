/**
 * GitHub-Compatible Git Data Endpoints
 *
 * Passthrough to Gitea for pure git data operations.
 *
 * GET /repos/:owner/:repo/contents/:path — file contents
 * GET /repos/:owner/:repo/git/refs — git references
 * GET /repos/:owner/:repo/commits — commit history
 */
import type { FastifyInstance } from 'fastify';
import { githubCompatAuth, resolveRepoFromParams } from './index.js';
import { config } from '../../config/env.js';

/**
 * Proxy a request to Gitea's API and return the response.
 */
async function giteaProxy(
  giteaOwner: string,
  giteaRepo: string,
  path: string,
  queryString?: string
): Promise<{ status: number; body: any }> {
  const giteaUrl = config.gitea.url;
  if (!giteaUrl) {
    return { status: 503, body: { message: 'Gitea not configured' } };
  }

  const qs = queryString ? `?${queryString}` : '';
  const url = `${giteaUrl}/api/v1/repos/${encodeURIComponent(giteaOwner)}/${encodeURIComponent(giteaRepo)}${path}${qs}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${config.gitea.adminToken}`,
      'Accept': 'application/json',
    },
  });

  const body = res.ok ? await res.json() : { message: await res.text().catch(() => 'Gitea error') };
  return { status: res.status, body };
}

export async function gitDataRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /repos/:owner/:repo/contents/:path
   * File contents passthrough.
   */
  app.get('/repos/:owner/:repo/contents/*', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const filePath = (request.params as any)['*'] || '';
    const { ref } = request.query as { ref?: string };

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const qs = ref ? `ref=${encodeURIComponent(ref)}` : '';
    const { status, body } = await giteaProxy(
      repoRecord.gitea_owner || owner,
      repoRecord.gitea_repo_name || repoName,
      `/contents/${filePath}`,
      qs
    );

    return reply.status(status).send(body);
  });

  /**
   * GET /repos/:owner/:repo/git/refs
   * Git references passthrough.
   */
  app.get('/repos/:owner/:repo/git/refs', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Gitea doesn't have a direct /git/refs endpoint — combine branches + tags
    const giteaOwner = repoRecord.gitea_owner || owner;
    const giteaRepo = repoRecord.gitea_repo_name || repoName;

    const [branches, tags] = await Promise.all([
      giteaProxy(giteaOwner, giteaRepo, '/branches'),
      giteaProxy(giteaOwner, giteaRepo, '/tags'),
    ]);

    const refs: any[] = [];

    if (branches.status === 200 && Array.isArray(branches.body)) {
      for (const b of branches.body) {
        refs.push({
          ref: `refs/heads/${b.name}`,
          object: { sha: b.commit?.id, type: 'commit' },
        });
      }
    }

    if (tags.status === 200 && Array.isArray(tags.body)) {
      for (const t of tags.body) {
        refs.push({
          ref: `refs/tags/${t.name}`,
          object: { sha: t.id || t.commit?.sha, type: 'tag' },
        });
      }
    }

    return refs;
  });

  /**
   * GET /repos/:owner/:repo/commits
   * Commit history passthrough.
   */
  app.get('/repos/:owner/:repo/commits', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { sha, per_page, page } = request.query as Record<string, any>;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const params = new URLSearchParams();
    if (sha) params.set('sha', sha);
    if (per_page) params.set('limit', per_page);
    if (page) params.set('page', page);

    const { status, body } = await giteaProxy(
      repoRecord.gitea_owner || owner,
      repoRecord.gitea_repo_name || repoName,
      '/commits',
      params.toString()
    );

    return reply.status(status).send(body);
  });

  /**
   * GET /repos/:owner/:repo/tags
   * Tags passthrough.
   */
  app.get('/repos/:owner/:repo/tags', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const { status, body } = await giteaProxy(
      repoRecord.gitea_owner || owner,
      repoRecord.gitea_repo_name || repoName,
      '/tags'
    );

    return reply.status(status).send(body);
  });
}
