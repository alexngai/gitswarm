/**
 * GitHub-Compatible API Facade
 *
 * Exposes a /api/v3/ surface that translates GitHub REST API calls into
 * GitSwarm operations. External tools (Renovate, gh CLI, CI bots) can
 * interact with GitSwarm as if it were GitHub.
 *
 * Key translations:
 *   - Pull Requests → GitSwarm Streams (governance-gated)
 *   - PR Reviews → Consensus votes
 *   - Issues → GitSwarm Tasks
 *   - Git data (refs, branches, contents) → Passthrough to Gitea
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { hashApiKey } from '../../middleware/authenticate.js';
import { reposRoutes } from './repos.js';
import { pullsRoutes } from './pulls.js';
import { issuesRoutes } from './issues.js';
import { gitDataRoutes } from './git.js';
import { dispatchRoutes } from './dispatches.js';

/**
 * GitHub-compatible auth middleware.
 * Supports both "Bearer <token>" and "token <token>" (GitHub-style) prefixes.
 * Maps to GitSwarm agent API keys.
 */
export async function githubCompatAuth(request: any, reply: any): Promise<void> {
  const authHeader: string | undefined = request.headers.authorization;

  if (!authHeader) {
    return reply.status(401).send({
      message: 'Requires authentication',
      documentation_url: 'https://docs.gitswarm.dev/auth',
    });
  }

  let apiKey: string | null = null;

  if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (authHeader.startsWith('token ')) {
    apiKey = authHeader.slice(6);
  }

  if (!apiKey) {
    return reply.status(401).send({
      message: 'Bad credentials',
      documentation_url: 'https://docs.gitswarm.dev/auth',
    });
  }

  const apiKeyHash = hashApiKey(apiKey);

  try {
    const result = await query(
      'SELECT id, name, karma, status FROM agents WHERE api_key_hash = $1',
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({
        message: 'Bad credentials',
      });
    }

    const agent = result.rows[0];
    if (agent.status !== 'active') {
      return reply.status(403).send({
        message: 'Account suspended',
      });
    }

    request.agent = agent;
  } catch {
    return reply.status(500).send({
      message: 'Authentication error',
    });
  }
}

/**
 * Resolve a GitSwarm repo from :owner/:repo URL params.
 * Looks up by gitea_owner + gitea_repo_name, falls back to github_full_name.
 */
export async function resolveRepoFromParams(owner: string, repo: string): Promise<Record<string, any> | null> {
  const result = await query(`
    SELECT r.*, o.id as org_id, o.github_org_name, o.gitea_org_name
    FROM gitswarm_repos r
    JOIN gitswarm_orgs o ON r.org_id = o.id
    WHERE (r.gitea_owner = $1 AND r.gitea_repo_name = $2)
       OR r.github_full_name = $3
    LIMIT 1
  `, [owner, repo, `${owner}/${repo}`]);

  return result.rows[0] || null;
}

/**
 * Map a GitSwarm stream status to a GitHub PR state.
 */
export function mapStreamStatusToGitHubState(status: string): string {
  switch (status) {
    case 'active':
    case 'in_review':
      return 'open';
    case 'merged':
      return 'closed';
    case 'abandoned':
      return 'closed';
    default:
      return 'open';
  }
}

/**
 * Register all GitHub-compatible routes under the /api/v3/ prefix.
 */
export async function githubCompatRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  // Register sub-routes
  await app.register(reposRoutes, options);
  await app.register(pullsRoutes, options);
  await app.register(issuesRoutes, options);
  await app.register(gitDataRoutes, options);
  await app.register(dispatchRoutes, options);

  // GET /user — current authenticated agent as GitHub user
  app.get('/user', {
    preHandler: [githubCompatAuth],
  }, async (request) => {
    const agent = (request as any).agent;
    return {
      login: agent.name,
      id: agent.id,
      type: 'Bot',
      site_admin: false,
    };
  });
}
