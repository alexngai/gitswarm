import { query } from '../config/database.js';
import { githubApp } from './github.js';

interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: string;
}

interface CommitOptions {
  sha?: string;
  path?: string;
  since?: string;
  until?: string;
  per_page?: number;
}

interface PullRequestOptions {
  state?: string;
  sort?: string;
  direction?: string;
  per_page?: number;
}

interface PullRequestData {
  title: string;
  body: string;
  head: string;
  base?: string;
  draft?: boolean;
}

interface MergeOptions {
  merge_method?: string;
  commit_title?: string;
  commit_message?: string;
}

/**
 * GitSwarm Service
 * Manages GitHub API interactions for the GitSwarm agent development ecosystem
 */
export class GitSwarmService {
  private db: DbClient | null;
  private query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  private tokenCache: Map<string, TokenCacheEntry>;

  constructor(db: DbClient | null = null) {
    this.db = db;
    this.query = db?.query || query;
    this.tokenCache = new Map();
  }

  /**
   * Get an installation access token for a GitSwarm org
   * @param {string} orgId - GitSwarm org UUID
   * @returns {Promise<string>} Installation access token
   */
  async getInstallationToken(orgId: string): Promise<string> {
    // Check cache first
    const cached = this.tokenCache.get(orgId);
    if (cached && new Date(cached.expiresAt) > new Date(Date.now() + 60000)) {
      return cached.token;
    }

    // Get installation ID from org
    const org = await this.query(`
      SELECT github_installation_id FROM gitswarm_orgs
      WHERE id = $1 AND status = 'active'
    `, [orgId]);

    if (org.rows.length === 0) {
      throw new Error(`GitSwarm org not found or inactive: ${orgId}`);
    }

    const installationId = org.rows[0].github_installation_id;
    const tokenData: any = await githubApp.getInstallationToken(installationId);

    // Cache token
    this.tokenCache.set(orgId, {
      token: tokenData.token || tokenData,
      expiresAt: tokenData.expires_at || ''
    });

    return tokenData.token || tokenData;
  }

  /**
   * Get installation token by repo ID
   * @param {string} repoId - GitSwarm repo UUID
   * @returns {Promise<string>} Installation access token
   */
  async getTokenForRepo(repoId: string): Promise<string> {
    const repo = await this.query(`
      SELECT org_id FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    return this.getInstallationToken(repo.rows[0].org_id);
  }

  /**
   * Get repository details including clone URL with token
   * @param {string} repoId - GitSwarm repo UUID
   * @returns {Promise<{repo: object, cloneUrl: string, token: string}>}
   */
  async getRepoWithCloneAccess(repoId: string): Promise<{ repo: Record<string, any>; cloneUrl: string; token: string }> {
    const repo = await this.query(`
      SELECT
        r.*,
        o.github_org_name,
        o.github_installation_id
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const repoData = repo.rows[0];
    const token = await this.getInstallationToken(repoData.org_id);

    // Generate authenticated clone URL
    const cloneUrl = `https://x-access-token:${token}@github.com/${repoData.github_full_name}.git`;

    return {
      repo: repoData,
      cloneUrl,
      token
    };
  }

  /**
   * Get file contents from a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} path - File path in repo
   * @param {string} ref - Branch/commit ref (optional)
   * @returns {Promise<{content: string, sha: string, encoding: string}>}
   */
  async getFileContents(repoId: string, path: string, ref: string | null = null): Promise<{ content: string; sha: string; encoding: string; size: number; path: string }> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');
    const targetRef = ref || default_branch;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${targetRef}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`File not found: ${path}`);
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    // Decode base64 content
    let content = data.content;
    if (data.encoding === 'base64') {
      content = Buffer.from(data.content, 'base64').toString('utf-8');
    }

    return {
      content,
      sha: data.sha,
      encoding: data.encoding,
      size: data.size,
      path: data.path
    };
  }

  /**
   * Get directory contents from a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} path - Directory path in repo
   * @param {string} ref - Branch/commit ref (optional)
   * @returns {Promise<Array<{name: string, path: string, type: string, sha: string}>>}
   */
  async getDirectoryContents(repoId: string, path: string = '', ref: string | null = null): Promise<Array<{ name: string; path: string; type: string; sha: string; size: number }>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');
    const targetRef = ref || default_branch;

    const url = path
      ? `https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${targetRef}`
      : `https://api.github.com/repos/${owner}/${repoName}/contents?ref=${targetRef}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Path not found: ${path}`);
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    // Single file returns object, directory returns array
    if (!Array.isArray(data)) {
      return [{
        name: data.name,
        path: data.path,
        type: data.type,
        sha: data.sha,
        size: data.size
      }];
    }

    return data.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
      sha: item.sha,
      size: item.size
    }));
  }

  /**
   * Get repository tree (recursive directory listing)
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} ref - Branch/commit ref (optional)
   * @param {boolean} recursive - Whether to get tree recursively
   * @returns {Promise<Array<{path: string, type: string, sha: string}>>}
   */
  async getTree(repoId: string, ref: string | null = null, recursive: boolean = true): Promise<{ sha: string; truncated: boolean; tree: Array<{ path: string; type: string; sha: string; size: number; mode: string }> }> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');
    const targetRef = ref || default_branch;

    const url = `https://api.github.com/repos/${owner}/${repoName}/git/trees/${targetRef}${recursive ? '?recursive=1' : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      sha: data.sha,
      truncated: data.truncated,
      tree: data.tree.map(item => ({
        path: item.path,
        type: item.type,
        sha: item.sha,
        size: item.size,
        mode: item.mode
      }))
    };
  }

  /**
   * Get commits for a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {object} options - Options (sha, path, since, until, per_page)
   * @returns {Promise<Array<object>>}
   */
  async getCommits(repoId: string, options: CommitOptions = {}): Promise<Array<Record<string, any>>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const params = new URLSearchParams();
    params.set('sha', options.sha || default_branch);
    if (options.path) params.set('path', options.path);
    if (options.since) params.set('since', options.since);
    if (options.until) params.set('until', options.until);
    params.set('per_page', String(options.per_page || 30));

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/commits?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return data.map(commit => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: {
        name: commit.commit.author.name,
        email: commit.commit.author.email,
        date: commit.commit.author.date
      },
      committer: {
        name: commit.commit.committer.name,
        email: commit.commit.committer.email,
        date: commit.commit.committer.date
      },
      url: commit.html_url
    }));
  }

  /**
   * Get branches for a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @returns {Promise<Array<{name: string, sha: string, protected: boolean}>>}
   */
  async getBranches(repoId: string): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/branches`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return data.map(branch => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected
    }));
  }

  /**
   * Get pull requests for a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {object} options - Options (state, sort, direction, per_page)
   * @returns {Promise<Array<object>>}
   */
  async getPullRequests(repoId: string, options: PullRequestOptions = {}): Promise<Array<Record<string, any>>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const params = new URLSearchParams();
    params.set('state', options.state || 'open');
    params.set('sort', options.sort || 'created');
    params.set('direction', options.direction || 'desc');
    params.set('per_page', String(options.per_page || 30));

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/pulls?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return data.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      body: pr.body,
      url: pr.html_url,
      head: {
        ref: pr.head.ref,
        sha: pr.head.sha
      },
      base: {
        ref: pr.base.ref,
        sha: pr.base.sha
      },
      user: pr.user.login,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      merged_at: pr.merged_at,
      draft: pr.draft
    }));
  }

  /**
   * Create a file in a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} path - File path
   * @param {string} content - File content
   * @param {string} message - Commit message
   * @param {string} branch - Target branch (optional)
   * @param {string} authorName - Author name
   * @param {string} authorEmail - Author email
   * @returns {Promise<{commit: object, content: object}>}
   */
  async createFile(repoId: string, path: string, content: string, message: string, branch: string, authorName: string, authorEmail: string): Promise<Record<string, any>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch: branch || default_branch,
      author: {
        name: authorName,
        email: authorEmail
      }
    };

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub API error: ${response.status} - ${error.message}`);
    }

    return response.json();
  }

  /**
   * Update a file in a repository
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} path - File path
   * @param {string} content - New file content
   * @param {string} message - Commit message
   * @param {string} sha - Current file SHA
   * @param {string} branch - Target branch (optional)
   * @param {string} authorName - Author name
   * @param {string} authorEmail - Author email
   * @returns {Promise<{commit: object, content: object}>}
   */
  async updateFile(repoId: string, path: string, content: string, message: string, sha: string, branch: string, authorName: string, authorEmail: string): Promise<Record<string, any>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      sha,
      branch: branch || default_branch,
      author: {
        name: authorName,
        email: authorEmail
      }
    };

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub API error: ${response.status} - ${error.message}`);
    }

    return response.json();
  }

  /**
   * Create a pull request
   * @param {string} repoId - GitSwarm repo UUID
   * @param {object} prData - PR data (title, body, head, base)
   * @returns {Promise<object>}
   */
  async createPullRequest(repoId: string, prData: PullRequestData): Promise<Record<string, any>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id, default_branch
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id, default_branch } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const body = {
      title: prData.title,
      body: prData.body,
      head: prData.head,
      base: prData.base || default_branch,
      draft: prData.draft || false
    };

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/pulls`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub API error: ${response.status} - ${error.message}`);
    }

    return response.json();
  }

  /**
   * Create a branch
   * @param {string} repoId - GitSwarm repo UUID
   * @param {string} branchName - New branch name
   * @param {string} fromSha - SHA to branch from
   * @returns {Promise<object>}
   */
  async createBranch(repoId: string, branchName: string, fromSha: string): Promise<Record<string, any>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/refs`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: fromSha
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub API error: ${response.status} - ${error.message}`);
    }

    return response.json();
  }

  /**
   * Merge a pull request
   * @param {string} repoId - GitSwarm repo UUID
   * @param {number} prNumber - Pull request number
   * @param {object} options - Merge options (merge_method, commit_title, commit_message)
   * @returns {Promise<object>}
   */
  async mergePullRequest(repoId: string, prNumber: number, options: MergeOptions = {}): Promise<Record<string, any>> {
    const repo = await this.query(`
      SELECT github_full_name, org_id
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error(`GitSwarm repo not found: ${repoId}`);
    }

    const { github_full_name, org_id } = repo.rows[0];
    const token = await this.getInstallationToken(org_id);

    const [owner, repoName] = github_full_name.split('/');

    const body: Record<string, any> = {
      merge_method: options.merge_method || 'squash'
    };

    if (options.commit_title) body.commit_title = options.commit_title;
    if (options.commit_message) body.commit_message = options.commit_message;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub API error: ${response.status} - ${error.message}`);
    }

    return response.json();
  }

  /**
   * Clear token cache for an org
   * @param {string} orgId - GitSwarm org UUID
   */
  clearTokenCache(orgId: string): void {
    this.tokenCache.delete(orgId);
  }

  /**
   * Clear entire token cache
   */
  clearAllTokenCache(): void {
    this.tokenCache.clear();
  }
}

// Export singleton instance
export const gitswarmService = new GitSwarmService();
