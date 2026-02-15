/**
 * Backend Factory
 *
 * Selects the appropriate GitBackend implementation for a repository
 * based on its `git_backend` configuration.
 *
 * Repos default to 'github' backend. Mode C repos set 'cascade'.
 */
import { query } from '../config/database.js';
import { GitHubBackend } from './github-backend.js';
import { CascadeBackend } from './cascade-backend.js';
import type { GitBackend } from './git-backend.js';

// Cached singleton instances
const githubBackend: GitHubBackend = new GitHubBackend();
const cascadeBackend: CascadeBackend = new CascadeBackend();

/**
 * Get the appropriate backend for a repository.
 *
 * Checks the `git_backend` column on gitswarm_repos:
 *   - 'github' (default): routes to GitHub REST API
 *   - 'cascade': routes to server-side git-cascade
 *
 * @param {string} repoId
 * @returns {Promise<import('./git-backend.js').GitBackend>}
 */
export async function getBackendForRepo(repoId: string): Promise<GitBackend> {
  const result = await query(`
    SELECT git_backend FROM gitswarm_repos WHERE id = $1
  `, [repoId]);

  const backend = result.rows[0]?.git_backend || 'github';

  switch (backend) {
    case 'cascade':
      return cascadeBackend;
    case 'github':
    default:
      return githubBackend;
  }
}

/**
 * Get a specific backend by name (for tests or explicit selection).
 */
export function getBackend(name: string): GitBackend {
  switch (name) {
    case 'cascade': return cascadeBackend;
    case 'github': return githubBackend;
    default: throw new Error(`Unknown backend: ${name}`);
  }
}
