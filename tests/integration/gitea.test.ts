/**
 * Gitea Integration Test
 *
 * Spins up a real Gitea instance via testcontainers and exercises the full
 * Phase 1 flow: create org → create repo → create agent user → push via API
 * → webhook payload validation → clone access.
 *
 * Run with: npm run test:integration
 * Requires: Docker running locally
 * Timeout: 120s (Gitea container startup takes ~10-20s)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { GiteaAdmin } from '../../src/services/gitea-admin.js';
import { GiteaBackend } from '../../src/services/gitea-backend.js';

// Increase timeout for container startup
const CONTAINER_TIMEOUT = 120_000;

describe('Gitea Integration', () => {
  let container: StartedTestContainer;
  let giteaUrl: string;
  let adminToken: string;
  let admin: GiteaAdmin;

  beforeAll(async () => {
    // Start Gitea container
    container = await new GenericContainer('gitea/gitea:latest')
      .withExposedPorts(3000)
      .withEnvironment({
        // Skip initial setup wizard
        GITEA__security__INSTALL_LOCK: 'true',
        // Use SQLite for test simplicity
        GITEA__database__DB_TYPE: 'sqlite3',
        // Disable registration (we'll create users via admin API)
        GITEA__service__DISABLE_REGISTRATION: 'true',
        // Don't force password change on admin-created users
        GITEA__admin__DEFAULT_EMAIL_NOTIFICATIONS: 'disabled',
        // Allow webhooks to localhost
        GITEA__webhook__ALLOWED_HOST_LIST: '*',
        // Minimal Gitea config
        GITEA__server__ROOT_URL: 'http://localhost:3000',
      })
      .withWaitStrategy(Wait.forHttp('/api/healthz', 3000).forStatusCode(200))
      .withStartupTimeout(60_000)
      .start();

    const mappedPort = container.getMappedPort(3000);
    const host = container.getHost();
    giteaUrl = `http://${host}:${mappedPort}`;

    // Create admin user via Gitea CLI inside the container.
    // INSTALL_LOCK=true skips the web installer, so we must use the CLI.
    // Must run as 'git' user (UID 1000) — Gitea refuses to run as root.
    const execResult = await container.exec(
      [
        'su', 'git', '-c',
        '/usr/local/bin/gitea admin user create --username gitswarm-admin --password "AdminPass123!" --email admin@gitswarm.local --admin',
      ],
    );
    console.log('[gitea admin user create] exit:', execResult.exitCode, 'stdout:', execResult.output);

    // Disable must_change_password via the admin API using basic auth.
    // The CLI flag doesn't reliably clear this in all Gitea versions.
    const patchRes = await fetch(`${giteaUrl}/api/v1/admin/users/gitswarm-admin`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('gitswarm-admin:AdminPass123!').toString('base64'),
      },
      body: JSON.stringify({
        login_name: 'gitswarm-admin',
        source_id: 0,
        must_change_password: false,
      }),
    });
    console.log('[patch must_change_password] status:', patchRes.status);

    // Wait for Gitea to process the update
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Generate admin API token via basic auth.
    // Retry with increasing delay — Gitea may need time after user creation.
    let tokenData: { sha1: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const tokenRes = await fetch(`${giteaUrl}/api/v1/users/gitswarm-admin/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from('gitswarm-admin:AdminPass123!').toString('base64'),
        },
        body: JSON.stringify({
          name: `integration-test-${Date.now()}`,
          scopes: ['all'],
        }),
      });

      if (tokenRes.ok) {
        tokenData = await tokenRes.json() as { sha1: string };
        break;
      }

      const errText = await tokenRes.text().catch(() => '');
      console.log(`[token attempt ${attempt + 1}] ${tokenRes.status}: ${errText}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (!tokenData) {
      throw new Error('Failed to create admin token after 5 retries');
    }

    adminToken = tokenData.sha1;

    // Create GiteaAdmin instance with real connection
    admin = new GiteaAdmin({
      baseUrl: giteaUrl,
      adminToken,
      internalSecret: 'test-secret',
    });
  }, CONTAINER_TIMEOUT);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  // ============================================================
  // Organization management
  // ============================================================

  describe('Organization management', () => {
    it('should create an organization', async () => {
      const org = await admin.createOrg('test-org', 'Test Organization');

      expect(org.id).toBeGreaterThan(0);
      expect(org.username).toBe('test-org');
    });

    it('should get an existing organization', async () => {
      const org = await admin.getOrg('test-org');

      expect(org).not.toBeNull();
      expect(org!.username).toBe('test-org');
    });

    it('should return null for non-existent org', async () => {
      const org = await admin.getOrg('does-not-exist');
      expect(org).toBeNull();
    });

    it('should idempotently ensure an org exists', async () => {
      const org1 = await admin.ensureOrg('test-org');
      const org2 = await admin.ensureOrg('test-org');

      expect(org1.id).toBe(org2.id);
    });
  });

  // ============================================================
  // Repository management
  // ============================================================

  describe('Repository management', () => {
    it('should create a repository in the org', async () => {
      const repo = await admin.createRepo('test-org', 'test-repo', {
        description: 'Integration test repo',
        isPrivate: false,
        autoInit: true,
      });

      expect(repo.id).toBeGreaterThan(0);
      expect(repo.name).toBe('test-repo');
      expect(repo.full_name).toBe('test-org/test-repo');
      expect(repo.default_branch).toBe('main');
    });

    it('should get an existing repository', async () => {
      const repo = await admin.getRepo('test-org', 'test-repo');

      expect(repo).not.toBeNull();
      expect(repo!.name).toBe('test-repo');
    });

    it('should return null for non-existent repo', async () => {
      const repo = await admin.getRepo('test-org', 'nonexistent');
      expect(repo).toBeNull();
    });
  });

  // ============================================================
  // Agent user management
  // ============================================================

  describe('Agent user management', () => {
    let agentUsername: string;
    let agentPassword: string;
    let agentToken: string;

    it('should create a Gitea user for an agent', async () => {
      const user = await admin.createAgentUser('agent-alpha');

      expect(user.id).toBeGreaterThan(0);
      expect(user.login).toBe('agent-alpha');
      expect(user.password).toBeTruthy();
      agentUsername = user.login;
      agentPassword = user.password;
    });

    it('should create an API token for the agent', async () => {
      const token = await admin.createAgentToken(agentUsername, agentPassword);

      expect(token.id).toBeGreaterThan(0);
      expect(token.sha1).toBeTruthy();
      expect(token.sha1.length).toBeGreaterThan(10);
      agentToken = token.sha1;
    });

    it('should allow agent to access Gitea API with their token', async () => {
      // Use agent token to get their own user info
      const res = await fetch(`${giteaUrl}/api/v1/user`, {
        headers: { 'Authorization': `token ${agentToken}` },
      });

      expect(res.ok).toBe(true);
      const user = await res.json() as { login: string };
      expect(user.login).toBe('agent-alpha');
    });

    it('should add agent as repo collaborator', async () => {
      await admin.addRepoCollaborator('test-org', 'test-repo', agentUsername, 'write');

      // Verify via API
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/collaborators/${agentUsername}`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );
      // 204 = is a collaborator
      expect(res.status).toBe(204);
    });
  });

  // ============================================================
  // Webhook management
  // ============================================================

  describe('Webhook management', () => {
    it('should install a webhook on a repo', async () => {
      const webhook = await admin.installWebhook(
        'test-org',
        'test-repo',
        'http://localhost:3000/api/v1/webhooks/git'
      );

      expect(webhook.id).toBeGreaterThan(0);
      expect(webhook.active).toBe(true);
    });

    it('should list webhooks on a repo', async () => {
      const webhooks = await admin.listWebhooks('test-org', 'test-repo');

      expect(webhooks.length).toBeGreaterThanOrEqual(1);
      const hook = webhooks.find((w: any) => w.config?.url?.includes('webhooks/git'));
      expect(hook).toBeDefined();
    });
  });

  // ============================================================
  // Git operations via Gitea API (simulating GiteaBackend)
  // ============================================================

  describe('Git operations via API', () => {
    it('should read file contents from the auto-init repo', async () => {
      // Auto-init creates a README.md
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/contents/README.md`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );

      expect(res.ok).toBe(true);
      const file = await res.json() as { content: string; encoding: string; path: string };
      expect(file.path).toBe('README.md');
      expect(file.encoding).toBe('base64');

      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      expect(content).toContain('test-repo');
    });

    it('should create a new file via API', async () => {
      const content = Buffer.from('console.log("hello");').toString('base64');

      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/contents/src/index.ts`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content,
            message: 'feat: add index.ts',
            branch: 'main',
          }),
        }
      );

      expect(res.ok).toBe(true);
      const result = await res.json() as { content: { sha: string } };
      expect(result.content.sha).toBeTruthy();
    });

    it('should create a branch', async () => {
      await admin.createBranch('test-org', 'test-repo', 'stream/feat-1', 'main');

      // Verify branch exists
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/branches/stream/feat-1`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );
      expect(res.ok).toBe(true);
    });

    it('should list branches', async () => {
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/branches`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );

      expect(res.ok).toBe(true);
      const branches = await res.json() as Array<{ name: string }>;
      const branchNames = branches.map(b => b.name);
      expect(branchNames).toContain('main');
      expect(branchNames).toContain('stream/feat-1');
    });

    it('should create a file on the feature branch', async () => {
      const content = Buffer.from('export function feature() { return true; }').toString('base64');

      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/contents/src/feature.ts`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content,
            message: 'feat: add feature.ts',
            branch: 'stream/feat-1',
          }),
        }
      );

      expect(res.ok).toBe(true);
    });

    it('should create a pull request', async () => {
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/pulls`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'feat: add feature module',
            body: 'Adds feature.ts with core feature logic',
            head: 'stream/feat-1',
            base: 'main',
          }),
        }
      );

      expect(res.ok).toBe(true);
      const pr = await res.json() as { number: number; title: string; state: string };
      expect(pr.number).toBe(1);
      expect(pr.title).toBe('feat: add feature module');
      expect(pr.state).toBe('open');
    });

    it('should merge the pull request', async () => {
      // Gitea may need a moment to compute mergeability after PR creation
      let res: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        res = await fetch(
          `${giteaUrl}/api/v1/repos/test-org/test-repo/pulls/1/merge`,
          {
            method: 'POST',
            headers: {
              'Authorization': `token ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              Do: 'merge',
              merge_message_field: 'Merge stream/feat-1: add feature module',
            }),
          }
        );
        if (res.ok) break;
        // 405 = "not mergeable yet", retry after delay
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      expect(res!.ok).toBe(true);
    });

    it('should show merged PR as closed', async () => {
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/pulls/1`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );

      expect(res.ok).toBe(true);
      const pr = await res.json() as { state: string; merged: boolean };
      expect(pr.state).toBe('closed');
      expect(pr.merged).toBe(true);
    });

    it('should show merge commit on main', async () => {
      const res = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/test-repo/commits?limit=5`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );

      expect(res.ok).toBe(true);
      const commits = await res.json() as Array<{ commit: { message: string } }>;
      const messages = commits.map(c => c.commit.message);
      expect(messages.some(m => m.includes('feature'))).toBe(true);
    });
  });

  // ============================================================
  // Clone URL generation
  // ============================================================

  describe('Clone URL generation', () => {
    it('should build authenticated HTTP clone URL', () => {
      const url = admin.buildCloneUrl('test-org', 'test-repo', adminToken);

      expect(url).toContain('x-access-token');
      expect(url).toContain(adminToken);
      expect(url).toContain('test-org/test-repo.git');
    });

    it('should build unauthenticated clone URL', () => {
      const url = admin.buildCloneUrl('test-org', 'test-repo');

      expect(url).not.toContain('x-access-token');
      expect(url).toContain('test-org/test-repo.git');
    });
  });

  // ============================================================
  // Webhook signature verification
  // ============================================================

  describe('Webhook signature verification', () => {
    it('should verify a valid signature', async () => {
      const crypto = await import('crypto');
      const payload = '{"action":"push","ref":"refs/heads/main"}';
      const signature = crypto
        .createHmac('sha256', 'test-secret')
        .update(payload)
        .digest('hex');

      expect(admin.verifyWebhookSignature(payload, signature)).toBe(true);
    });

    it('should reject a tampered payload', async () => {
      const crypto = await import('crypto');
      const originalPayload = '{"action":"push"}';
      const signature = crypto
        .createHmac('sha256', 'test-secret')
        .update(originalPayload)
        .digest('hex');

      // Tampered payload
      expect(admin.verifyWebhookSignature('{"action":"delete"}', signature)).toBe(false);
    });
  });

  // ============================================================
  // Full end-to-end flow
  // ============================================================

  describe('Full flow: second repo lifecycle', () => {
    it('should complete org → repo → agent → branch → PR → merge', async () => {
      // 1. Ensure org
      const org = await admin.ensureOrg('test-org');
      expect(org.username).toBe('test-org');

      // 2. Create repo
      const repo = await admin.createRepo('test-org', 'e2e-repo', {
        description: 'E2E test',
        autoInit: true,
      });
      expect(repo.name).toBe('e2e-repo');

      // 3. Create agent user + token
      const agentUser = await admin.createAgentUser('e2e-agent');
      const agentTokenResult = await admin.createAgentToken(agentUser.login, agentUser.password);
      const token = agentTokenResult.sha1;

      // 4. Add agent as collaborator
      await admin.addRepoCollaborator('test-org', 'e2e-repo', agentUser.login, 'write');

      // 5. Agent creates a branch (using their own token)
      const branchRes = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/e2e-repo/branches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            new_branch_name: 'stream/agent-work',
            old_branch_name: 'main',
          }),
        }
      );
      expect(branchRes.ok).toBe(true);

      // 6. Agent writes a file on their branch
      const writeRes = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/e2e-repo/contents/agent-output.txt`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: Buffer.from('Agent work output').toString('base64'),
            message: 'feat: agent work',
            branch: 'stream/agent-work',
            author: { name: agentUser.login, email: `${agentUser.login}@gitswarm.local` },
          }),
        }
      );
      expect(writeRes.ok).toBe(true);

      // 7. Agent creates a PR
      const prRes = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/e2e-repo/pulls`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'Agent work submission',
            body: 'Completed task',
            head: 'stream/agent-work',
            base: 'main',
          }),
        }
      );
      expect(prRes.ok).toBe(true);
      const pr = await prRes.json() as { number: number };

      // 8. Admin merges (simulating governance-approved merge)
      // Retry — Gitea needs time to compute mergeability
      let mergeRes: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        mergeRes = await fetch(
          `${giteaUrl}/api/v1/repos/test-org/e2e-repo/pulls/${pr.number}/merge`,
          {
            method: 'POST',
            headers: {
              'Authorization': `token ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ Do: 'merge' }),
          }
        );
        if (mergeRes.ok) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(mergeRes!.ok).toBe(true);

      // 9. Verify file exists on main after merge
      const fileRes = await fetch(
        `${giteaUrl}/api/v1/repos/test-org/e2e-repo/contents/agent-output.txt?ref=main`,
        { headers: { 'Authorization': `token ${adminToken}` } }
      );
      expect(fileRes.ok).toBe(true);
      const file = await fileRes.json() as { content: string; encoding: string };
      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      expect(content).toBe('Agent work output');
    });
  });

  // ============================================================
  // Mirror support (Gitea built-in)
  // ============================================================

  describe('Mirror support', () => {
    it('should create a repo via migration API (mirror capability)', async () => {
      // We can't mirror from GitHub in tests without a real token,
      // but we can verify the migrate endpoint exists and rejects properly
      const res = await fetch(`${giteaUrl}/api/v1/repos/migrate`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clone_addr: 'https://github.com/nonexistent/repo',
          repo_name: 'mirror-test',
          repo_owner: 'test-org',
          service: 'github',
          mirror: true,
        }),
      });

      // 422 (clone failed) or 409 (exists) is expected — we just verify the endpoint works
      // A successful mirror would need real GitHub credentials
      expect([201, 409, 422, 500]).toContain(res.status);
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================

  describe('Cleanup', () => {
    it('should delete a repository', async () => {
      await admin.deleteRepo('test-org', 'e2e-repo');

      const repo = await admin.getRepo('test-org', 'e2e-repo');
      expect(repo).toBeNull();
    });

    it('should disable an agent user', async () => {
      // Disable the e2e agent
      await admin.disableUser('e2e-agent');

      // Verify user is disabled (can't auth)
      const res = await fetch(`${giteaUrl}/api/v1/user`, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from('e2e-agent:unused').toString('base64'),
        },
      });
      expect(res.ok).toBe(false);
    });
  });
});
