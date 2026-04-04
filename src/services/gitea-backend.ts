/**
 * Gitea Backend
 *
 * Implements the GitBackend interface by calling Gitea's REST API.
 * Gitea's API at /api/v1/ intentionally mirrors GitHub's structure,
 * so most methods are straightforward URL + payload translations.
 *
 * Each repo's Gitea owner/name is resolved from the database.
 */
import { GitBackend } from './git-backend.js';
import { query } from '../config/database.js';
import { config } from '../config/env.js';
import { giteaAdmin, GiteaAdmin } from './gitea-admin.js';

interface GiteaRepoInfo {
  gitea_owner: string;
  gitea_repo_name: string;
  gitea_repo_id: number;
  org_id: string;
}

export class GiteaBackend extends GitBackend {
  private admin: GiteaAdmin;
  private baseUrl: string;

  constructor(admin?: GiteaAdmin) {
    super();
    this.admin = admin || giteaAdmin;
    this.baseUrl = config.gitea.url || '';
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Resolve Gitea owner/repo from the GitSwarm repo ID.
   */
  private async resolveRepo(repoId: string): Promise<GiteaRepoInfo> {
    const result = await query(`
      SELECT gitea_owner, gitea_repo_name, gitea_repo_id, org_id
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (result.rows.length === 0) {
      throw new Error(`Repository not found: ${repoId}`);
    }

    const row = result.rows[0];
    if (!row.gitea_owner || !row.gitea_repo_name) {
      throw new Error(`Repository ${repoId} is not configured for Gitea backend`);
    }

    return row as GiteaRepoInfo;
  }

  /**
   * Get the Gitea API token for an agent (from gitswarm_agent_gitea_users).
   * Falls back to admin token if agent has no mapping.
   */
  private async getAgentToken(agentId?: string): Promise<string> {
    if (agentId) {
      const result = await query(`
        SELECT gitea_token_hash FROM gitswarm_agent_gitea_users WHERE agent_id = $1
      `, [agentId]);
      if (result.rows.length > 0 && result.rows[0].gitea_token_hash) {
        return result.rows[0].gitea_token_hash;
      }
    }
    // Fall back to admin token
    return config.gitea.adminToken || '';
  }

  private async giteaRequest<T>(
    method: string,
    owner: string,
    repo: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
    const authToken = token || config.gitea.adminToken || '';

    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `token ${authToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gitea API ${method} ${path} failed (${res.status}): ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ============================================================
  // GitBackend interface implementation
  // ============================================================

  async readFile(repoId: string, path: string, ref?: string): Promise<{ content: string; path: string; sha?: string }> {
    const repo = await this.resolveRepo(repoId);
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : '';

    const result = await this.giteaRequest<{
      content: string;
      encoding: string;
      path: string;
      sha: string;
    }>('GET', repo.gitea_owner, repo.gitea_repo_name, `/contents/${encodeURIComponent(path)}${refParam}`);

    // Gitea returns base64-encoded content
    const content = result.encoding === 'base64'
      ? Buffer.from(result.content, 'base64').toString('utf-8')
      : result.content;

    return { content, path: result.path, sha: result.sha };
  }

  async listDirectory(repoId: string, path: string, ref?: string): Promise<Array<{ name: string; path: string; type: string }>> {
    const repo = await this.resolveRepo(repoId);
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : '';

    const result = await this.giteaRequest<Array<{
      name: string;
      path: string;
      type: string;
      sha: string;
      size: number;
    }>>('GET', repo.gitea_owner, repo.gitea_repo_name, `/contents/${encodeURIComponent(path)}${refParam}`);

    return result.map(entry => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
    }));
  }

  async getTree(repoId: string, ref?: string): Promise<any> {
    const repo = await this.resolveRepo(repoId);
    const treeRef = ref || 'main';

    return this.giteaRequest<any>(
      'GET', repo.gitea_owner, repo.gitea_repo_name,
      `/git/trees/${encodeURIComponent(treeRef)}?recursive=true`
    );
  }

  async getCommits(repoId: string, options?: Record<string, any>): Promise<any[]> {
    const repo = await this.resolveRepo(repoId);
    const params = new URLSearchParams();
    if (options?.sha) params.set('sha', options.sha);
    if (options?.path) params.set('path', options.path);
    if (options?.per_page) params.set('limit', String(options.per_page));
    const qs = params.toString() ? `?${params.toString()}` : '';

    const commits = await this.giteaRequest<any[]>(
      'GET', repo.gitea_owner, repo.gitea_repo_name, `/commits${qs}`
    );

    return commits.map(c => ({
      sha: c.sha,
      message: c.commit?.message,
      author: c.commit?.author,
      committer: c.commit?.committer,
      html_url: c.html_url,
    }));
  }

  async getBranches(repoId: string): Promise<Array<{ name: string; sha: string }>> {
    const repo = await this.resolveRepo(repoId);

    const branches = await this.giteaRequest<Array<{
      name: string;
      commit: { id: string };
      protected: boolean;
    }>>('GET', repo.gitea_owner, repo.gitea_repo_name, '/branches');

    return branches.map(b => ({
      name: b.name,
      sha: b.commit.id,
    }));
  }

  async writeFile(
    repoId: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    author?: { name: string; email: string }
  ): Promise<any> {
    const repo = await this.resolveRepo(repoId);
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');

    // Try to get existing file SHA for update
    let existingSha: string | undefined;
    try {
      const existing = await this.giteaRequest<{ sha: string }>(
        'GET', repo.gitea_owner, repo.gitea_repo_name,
        `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`
      );
      existingSha = existing.sha;
    } catch {
      // File doesn't exist, will create
    }

    const body: Record<string, any> = {
      content: base64Content,
      message,
      branch,
    };

    if (author) {
      body.author = { name: author.name, email: author.email };
      body.committer = { name: author.name, email: author.email };
    }

    if (existingSha) {
      // Update existing file
      body.sha = existingSha;
      return this.giteaRequest<any>(
        'PUT', repo.gitea_owner, repo.gitea_repo_name,
        `/contents/${encodeURIComponent(path)}`, body
      );
    } else {
      // Create new file
      return this.giteaRequest<any>(
        'POST', repo.gitea_owner, repo.gitea_repo_name,
        `/contents/${encodeURIComponent(path)}`, body
      );
    }
  }

  async createBranch(repoId: string, name: string, fromRef: string): Promise<Record<string, any>> {
    const repo = await this.resolveRepo(repoId);

    return this.giteaRequest<Record<string, any>>(
      'POST', repo.gitea_owner, repo.gitea_repo_name, '/branches',
      {
        new_branch_name: name,
        old_branch_name: fromRef,
      }
    );
  }

  async createPullRequest(repoId: string, prData: any): Promise<Record<string, any>> {
    const repo = await this.resolveRepo(repoId);

    return this.giteaRequest<Record<string, any>>(
      'POST', repo.gitea_owner, repo.gitea_repo_name, '/pulls',
      {
        title: prData.title,
        body: prData.body || '',
        head: prData.head,
        base: prData.base || 'main',
      }
    );
  }

  async mergePullRequest(repoId: string, prNumber: number | string, options?: Record<string, any>): Promise<Record<string, any>> {
    const repo = await this.resolveRepo(repoId);
    const mergeMethod = options?.merge_method || 'merge';

    return this.giteaRequest<Record<string, any>>(
      'POST', repo.gitea_owner, repo.gitea_repo_name, `/pulls/${prNumber}/merge`,
      {
        Do: mergeMethod,
        merge_message_field: options?.commit_message,
      }
    );
  }

  async getCloneAccess(repoId: string): Promise<{ cloneUrl: string; token?: string }> {
    const repo = await this.resolveRepo(repoId);

    // Look up agent token from pending context or use admin token
    const token = config.gitea.adminToken || '';
    const cloneUrl = this.admin.buildCloneUrl(repo.gitea_owner, repo.gitea_repo_name, token);

    return { cloneUrl, token };
  }

  /**
   * Get clone access for a specific agent (uses their Gitea token).
   */
  async getCloneAccessForAgent(repoId: string, agentId: string): Promise<{ cloneUrl: string; token?: string }> {
    const repo = await this.resolveRepo(repoId);
    const token = await this.getAgentToken(agentId);
    const cloneUrl = this.admin.buildCloneUrl(repo.gitea_owner, repo.gitea_repo_name, token);

    return { cloneUrl, token };
  }
}
