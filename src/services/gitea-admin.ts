/**
 * Gitea Admin Service
 *
 * Manages Gitea resources (orgs, repos, users, webhooks, hooks)
 * on behalf of GitSwarm. Uses Gitea's REST API with an admin token.
 */
import { config } from '../config/env.js';

interface GiteaOrg {
  id: number;
  username: string;
  full_name: string;
}

interface GiteaRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

interface GiteaUser {
  id: number;
  login: string;
  email: string;
}

interface GiteaToken {
  id: number;
  name: string;
  sha1: string;
}

interface GiteaWebhook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
}

export class GiteaAdmin {
  private baseUrl: string;
  private adminToken: string;
  private internalSecret: string;
  private webhookCallbackUrl: string;

  constructor(options?: {
    baseUrl?: string;
    adminToken?: string;
    internalSecret?: string;
    webhookCallbackUrl?: string;
  }) {
    this.baseUrl = options?.baseUrl !== undefined ? options.baseUrl : (config.gitea.url || '');
    this.adminToken = options?.adminToken !== undefined ? options.adminToken : (config.gitea.adminToken || '');
    this.internalSecret = options?.internalSecret !== undefined ? options.internalSecret : (config.gitea.internalSecret || '');
    this.webhookCallbackUrl = options?.webhookCallbackUrl || '';
  }

  get isConfigured(): boolean {
    return !!(this.baseUrl && this.adminToken);
  }

  // ============================================================
  // HTTP helpers
  // ============================================================

  private async request<T>(method: string, path: string, body?: unknown, sudoUser?: string): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      'Authorization': `token ${this.adminToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (sudoUser) {
      headers['Sudo'] = sudoUser;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gitea API ${method} ${path} failed (${res.status}): ${text}`);
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  private async requestWithToken<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
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
  // Organization management
  // ============================================================

  async createOrg(name: string, fullName?: string): Promise<GiteaOrg> {
    return this.request<GiteaOrg>('POST', '/orgs', {
      username: name,
      full_name: fullName || name,
      visibility: 'private',
    });
  }

  async getOrg(name: string): Promise<GiteaOrg | null> {
    try {
      return await this.request<GiteaOrg>('GET', `/orgs/${encodeURIComponent(name)}`);
    } catch {
      return null;
    }
  }

  async ensureOrg(name: string, fullName?: string): Promise<GiteaOrg> {
    const existing = await this.getOrg(name);
    if (existing) return existing;
    return this.createOrg(name, fullName);
  }

  // ============================================================
  // Repository management
  // ============================================================

  async createRepo(orgName: string, repoName: string, options?: {
    isPrivate?: boolean;
    description?: string;
    defaultBranch?: string;
    autoInit?: boolean;
  }): Promise<GiteaRepo> {
    return this.request<GiteaRepo>('POST', `/orgs/${encodeURIComponent(orgName)}/repos`, {
      name: repoName,
      description: options?.description || '',
      private: options?.isPrivate ?? false,
      default_branch: options?.defaultBranch || 'main',
      auto_init: options?.autoInit ?? true,
    });
  }

  async getRepo(owner: string, repo: string): Promise<GiteaRepo | null> {
    try {
      return await this.request<GiteaRepo>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      );
    } catch {
      return null;
    }
  }

  async deleteRepo(owner: string, repo: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
  }

  // ============================================================
  // User management (for agent-to-Gitea-user mapping)
  // ============================================================

  async createAgentUser(agentName: string, email?: string): Promise<GiteaUser & { password: string }> {
    // Gitea usernames: lowercase alphanumeric + hyphens, 1-40 chars
    const username = this.sanitizeUsername(agentName);
    const userEmail = email || `${username}@gitswarm.local`;

    // Generate a random password (needed for basic auth when creating tokens)
    const password = this.generateRandomPassword();

    const user = await this.request<GiteaUser>('POST', '/admin/users', {
      username,
      email: userEmail,
      password,
      must_change_password: false,
      visibility: 'private',
    });

    return { ...user, password };
  }

  async getUser(username: string): Promise<GiteaUser | null> {
    try {
      return await this.request<GiteaUser>('GET', `/users/${encodeURIComponent(username)}`);
    } catch {
      return null;
    }
  }

  async createAgentToken(username: string, password?: string): Promise<GiteaToken> {
    // Gitea 1.21+ requires the target user's own basic auth to create tokens.
    // If password is provided, use basic auth; otherwise fall back to admin token.
    if (password) {
      const url = `${this.baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        },
        body: JSON.stringify({
          name: `gitswarm-${Date.now()}`,
          scopes: ['write:repository', 'write:user'],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gitea API POST /users/${username}/tokens failed (${res.status}): ${text}`);
      }
      return res.json() as Promise<GiteaToken>;
    }

    // Fall back: admin token with Sudo header (works on older Gitea versions)
    return this.request<GiteaToken>(
      'POST',
      `/users/${encodeURIComponent(username)}/tokens`,
      {
        name: `gitswarm-${Date.now()}`,
        scopes: ['write:repository', 'write:user'],
      },
      username
    );
  }

  async deleteAgentToken(username: string, tokenId: number): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/users/${encodeURIComponent(username)}/tokens/${tokenId}`
    );
  }

  async disableUser(username: string): Promise<void> {
    await this.request<void>(
      'PATCH',
      `/admin/users/${encodeURIComponent(username)}`,
      { login_name: username, source_id: 0, active: false, prohibit_login: true }
    );
  }

  /**
   * Add a Gitea user as a collaborator on a repo.
   */
  async addRepoCollaborator(
    owner: string, repo: string, username: string, permission: 'read' | 'write' | 'admin' = 'write'
  ): Promise<void> {
    await this.request<void>(
      'PUT',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
      { permission }
    );
  }

  // ============================================================
  // Webhook management
  // ============================================================

  async installWebhook(
    owner: string,
    repo: string,
    callbackUrl: string,
    events?: string[]
  ): Promise<GiteaWebhook> {
    const webhookEvents = events || [
      'push',
      'pull_request',
      'pull_request_review',
      'issues',
      'issue_comment',
    ];

    return this.request<GiteaWebhook>(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
      {
        type: 'gitea',
        config: {
          url: callbackUrl,
          content_type: 'json',
          secret: this.internalSecret,
        },
        events: webhookEvents,
        active: true,
      }
    );
  }

  async listWebhooks(owner: string, repo: string): Promise<GiteaWebhook[]> {
    return this.request<GiteaWebhook[]>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`
    );
  }

  // ============================================================
  // Mirror management
  // ============================================================

  async mirrorFromGitHub(
    githubUrl: string,
    orgName: string,
    repoName: string,
    options?: { githubToken?: string; mirror?: boolean }
  ): Promise<GiteaRepo> {
    return this.request<GiteaRepo>('POST', '/repos/migrate', {
      clone_addr: githubUrl,
      auth_token: options?.githubToken,
      repo_name: repoName,
      repo_owner: orgName,
      service: 'github',
      mirror: options?.mirror ?? true,
      private: false,
    });
  }

  async createPushMirror(
    owner: string,
    repo: string,
    remoteUrl: string,
    remoteToken: string,
    interval?: string
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/push-mirrors`,
      {
        remote_address: remoteUrl,
        remote_username: 'x-access-token',
        remote_password: remoteToken,
        interval: interval || '8h0m0s',
        sync_on_commit: true,
      }
    );
  }

  // ============================================================
  // Branch operations
  // ============================================================

  async createBranch(owner: string, repo: string, branchName: string, fromBranch: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      {
        new_branch_name: branchName,
        old_branch_name: fromBranch,
      }
    );
  }

  // ============================================================
  // Server-side hook management
  // ============================================================

  /**
   * Install GitSwarm governance hooks (pre-receive, post-receive) into a Gitea repo.
   * Uses Gitea's API to set custom git hooks on the repo.
   *
   * Gitea exposes git hooks via:
   *   GET/PATCH /api/v1/repos/{owner}/{repo}/hooks/git
   */
  async installServerHooks(
    owner: string,
    repo: string,
    options?: {
      apiUrl?: string;
      internalSecret?: string;
    }
  ): Promise<void> {
    const apiUrl = options?.apiUrl || 'http://api:3000/api/v1';
    const secret = options?.internalSecret || this.internalSecret;

    const preReceiveContent = `#!/bin/bash
# GitSwarm pre-receive hook (auto-installed)
GITSWARM_API_URL="${apiUrl}"
GITSWARM_INTERNAL_SECRET="${secret}"
REPO_PATH="$(pwd)"

while read oldrev newrev refname; do
  if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
  RESULT=$(curl -sf --max-time 10 "\${GITSWARM_API_URL}/internal/git/pre-receive" \\
    -H "Content-Type: application/json" \\
    -H "X-Internal-Secret: \${GITSWARM_INTERNAL_SECRET}" \\
    -d "{\\"repo_path\\": \\"\${REPO_PATH}\\", \\"ref\\": \\"\${refname}\\", \\"old_sha\\": \\"\${oldrev}\\", \\"new_sha\\": \\"\${newrev}\\", \\"pusher\\": \\"\${GITEA_PUSHER_NAME:-unknown}\\"}" 2>/dev/null)
  if [ $? -ne 0 ]; then continue; fi
  ALLOWED=$(echo "$RESULT" | grep -o '"allowed":\\s*\\(true\\|false\\)' | grep -o 'true\\|false')
  if [ "$ALLOWED" != "true" ]; then
    REASON=$(echo "$RESULT" | grep -o '"reason":"[^"]*"' | sed 's/"reason":"//;s/"$//')
    echo "GitSwarm: push denied — \${REASON:-governance check failed}" >&2
    exit 1
  fi
done
exit 0`;

    const postReceiveContent = `#!/bin/bash
# GitSwarm post-receive hook (auto-installed)
GITSWARM_API_URL="${apiUrl}"
GITSWARM_INTERNAL_SECRET="${secret}"
REPO_PATH="$(pwd)"

while read oldrev newrev refname; do
  curl -sf --max-time 5 "\${GITSWARM_API_URL}/internal/git/post-receive" \\
    -H "Content-Type: application/json" \\
    -H "X-Internal-Secret: \${GITSWARM_INTERNAL_SECRET}" \\
    -d "{\\"repo_path\\": \\"\${REPO_PATH}\\", \\"ref\\": \\"\${refname}\\", \\"old_sha\\": \\"\${oldrev}\\", \\"new_sha\\": \\"\${newrev}\\", \\"pusher\\": \\"\${GITEA_PUSHER_NAME:-unknown}\\"}" >/dev/null 2>&1 &
done
wait 2>/dev/null
exit 0`;

    // Gitea git hooks API: PATCH /repos/{owner}/{repo}/hooks/git/{hook-name}
    // Each hook is updated individually (pre-receive, post-receive)
    const hooks = [
      { name: 'pre-receive', content: preReceiveContent },
      { name: 'post-receive', content: postReceiveContent },
    ];

    for (const hook of hooks) {
      try {
        await this.request<void>(
          'PATCH',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/git/${hook.name}`,
          { content: hook.content }
        );
      } catch (error) {
        // Gitea may not support the git hooks API in all editions.
        // Fall back silently — hooks can be installed manually.
        console.warn(`Failed to install ${hook.name} hook for ${owner}/${repo}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Verify that governance hooks are installed on a repo.
   * Returns true if the pre-receive hook contains the GitSwarm marker.
   */
  async verifyHooksInstalled(owner: string, repo: string): Promise<boolean> {
    try {
      const hook = await this.request<{ content: string }>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/git/pre-receive`
      );
      return !!(hook?.content?.includes('GitSwarm'));
    } catch {
      return false;
    }
  }

  /**
   * Verify and reinstall hooks for all Gitea-backed repos.
   * Call on startup to handle Gitea upgrades that may wipe custom hooks.
   */
  async verifyAllHooks(options?: { apiUrl?: string }): Promise<{ checked: number; reinstalled: number }> {
    const { query: dbQuery } = await import('../config/database.js');

    const repos = await dbQuery(`
      SELECT gitea_owner, gitea_repo_name FROM gitswarm_repos
      WHERE git_backend = 'gitea' AND gitea_owner IS NOT NULL AND status = 'active'
    `);

    let checked = 0;
    let reinstalled = 0;

    for (const repo of repos.rows) {
      checked++;
      const installed = await this.verifyHooksInstalled(repo.gitea_owner, repo.gitea_repo_name);
      if (!installed) {
        await this.installServerHooks(repo.gitea_owner, repo.gitea_repo_name, options);
        reinstalled++;
      }
    }

    return { checked, reinstalled };
  }

  // ============================================================
  // Utilities
  // ============================================================

  private sanitizeUsername(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'agent';
  }

  private generateRandomPassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars[Math.floor(Math.random() * chars.length)];
    }
    return password;
  }

  /**
   * Build a clone URL with token auth for an agent.
   */
  buildCloneUrl(owner: string, repo: string, token?: string): string {
    const baseUrl = config.gitea.externalUrl || config.gitea.url || this.baseUrl;
    if (token) {
      const parsed = new URL(baseUrl);
      return `${parsed.protocol}//x-access-token:${token}@${parsed.host}/${owner}/${repo}.git`;
    }
    return `${baseUrl}/${owner}/${repo}.git`;
  }

  /**
   * Build an SSH clone URL.
   */
  buildSshCloneUrl(owner: string, repo: string): string {
    const sshUrl = config.gitea.sshUrl;
    if (sshUrl) {
      return `${sshUrl}/${owner}/${repo}.git`;
    }
    return `git@localhost:${owner}/${repo}.git`;
  }

  /**
   * Verify a Gitea webhook signature (HMAC-SHA256).
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.internalSecret) return false;

    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', this.internalSecret)
      .update(payload)
      .digest('hex');

    if (signature.length !== expected.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  }
}

// Singleton instance
export const giteaAdmin = new GiteaAdmin();
