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
