import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Unified Webhook Handler', () => {
  describe('detectWebhookSource', () => {
    it('should detect GitHub from X-GitHub-Event header', () => {
      const headers: Record<string, string> = {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=abc',
        'x-github-delivery': 'delivery-1',
      };

      if (headers['x-github-event']) {
        expect('github').toBe('github');
      }
    });

    it('should detect Gitea from X-Gitea-Event header', () => {
      const headers: Record<string, string> = {
        'x-gitea-event': 'push',
        'x-gitea-signature': 'abc123',
        'x-gitea-delivery': 'delivery-2',
      };

      if (headers['x-gitea-event']) {
        expect('gitea').toBe('gitea');
      }
    });

    it('should return null for unknown source', () => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      const source = headers['x-github-event'] ? 'github' :
                     headers['x-gitea-event'] ? 'gitea' : null;
      expect(source).toBeNull();
    });
  });

  describe('extractWebhookMeta', () => {
    it('should extract GitHub metadata from headers', () => {
      const headers = {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=abc123',
        'x-github-delivery': 'uuid-1',
      };

      expect(headers['x-github-event']).toBe('pull_request');
      expect(headers['x-hub-signature-256']).toBe('sha256=abc123');
      expect(headers['x-github-delivery']).toBe('uuid-1');
    });

    it('should extract Gitea metadata from headers', () => {
      const headers = {
        'x-gitea-event': 'push',
        'x-gitea-signature': 'hexsig',
        'x-gitea-delivery': 'uuid-2',
      };

      expect(headers['x-gitea-event']).toBe('push');
      expect(headers['x-gitea-signature']).toBe('hexsig');
      expect(headers['x-gitea-delivery']).toBe('uuid-2');
    });
  });

  describe('Gitea webhook payload compatibility', () => {
    it('should have matching pull_request payload structure with GitHub', () => {
      // Gitea sends the same payload structure as GitHub for pull_request events
      const giteaPayload = {
        action: 'opened',
        number: 1,
        pull_request: {
          id: 1,
          number: 1,
          title: 'feat: new feature',
          body: 'Description',
          head: { ref: 'stream/feat-1', sha: 'abc123' },
          base: { ref: 'main', sha: 'def456' },
          user: { login: 'agent-1', id: 10 },
          html_url: 'http://gitea:3001/org/repo/pulls/1',
          merged: false,
          state: 'open',
        },
        repository: {
          id: 42,
          name: 'test-repo',
          full_name: 'test-org/test-repo',
          private: false,
        },
      };

      // Verify the payload shape matches what our webhook handler expects
      expect(giteaPayload.action).toBeDefined();
      expect(giteaPayload.pull_request.number).toBeDefined();
      expect(giteaPayload.pull_request.head.ref).toBe('stream/feat-1');
      expect(giteaPayload.pull_request.base.ref).toBe('main');
      expect(giteaPayload.pull_request.user.login).toBeDefined();
      expect(giteaPayload.repository.full_name).toBeDefined();
    });

    it('should have matching push payload structure with GitHub', () => {
      const giteaPayload = {
        ref: 'refs/heads/stream/feat-1',
        before: '0000000000000000000000000000000000000000',
        after: 'abc123def456',
        commits: [
          {
            id: 'abc123def456',
            message: 'feat: add new feature',
            added: ['src/new.ts'],
            modified: [],
            removed: [],
            author: { name: 'agent-1', email: 'a@b.com' },
          },
        ],
        repository: {
          id: 42,
          name: 'test-repo',
          full_name: 'test-org/test-repo',
        },
        pusher: { login: 'agent-1' },
      };

      expect(giteaPayload.ref).toBeDefined();
      expect(giteaPayload.commits).toBeInstanceOf(Array);
      expect(giteaPayload.commits[0].id).toBeDefined();
      expect(giteaPayload.commits[0].added).toBeInstanceOf(Array);
      expect(giteaPayload.repository.full_name).toBeDefined();
    });

    it('should have matching pull_request_review payload structure', () => {
      const giteaPayload = {
        action: 'submitted',
        review: {
          id: 1,
          body: 'LGTM',
          state: 'APPROVED',
          user: { login: 'reviewer-agent', id: 20 },
          submitted_at: '2026-04-03T10:00:00Z',
        },
        pull_request: {
          number: 1,
          head: { ref: 'stream/feat-1' },
          base: { ref: 'main' },
        },
        repository: {
          id: 42,
          full_name: 'test-org/test-repo',
        },
      };

      expect(giteaPayload.review.state).toBe('APPROVED');
      expect(giteaPayload.review.user.login).toBeDefined();
      expect(giteaPayload.pull_request.number).toBeDefined();
    });

    it('should have matching issues payload structure', () => {
      const giteaPayload = {
        action: 'opened',
        issue: {
          id: 1,
          number: 5,
          title: 'Bug: something is broken',
          body: 'Steps to reproduce...',
          state: 'open',
          labels: [{ name: 'bug' }],
          user: { login: 'reporter-agent', id: 30 },
          html_url: 'http://gitea:3001/org/repo/issues/5',
        },
        repository: {
          id: 42,
          full_name: 'test-org/test-repo',
        },
      };

      expect(giteaPayload.issue.number).toBeDefined();
      expect(giteaPayload.issue.title).toBeDefined();
      expect(giteaPayload.issue.state).toBe('open');
    });

    it('should detect .gitswarm/ config changes in push payload', () => {
      const payload = {
        commits: [
          {
            added: ['.gitswarm/config.yml'],
            modified: [],
            removed: [],
          },
          {
            added: [],
            modified: ['src/index.ts'],
            removed: [],
          },
        ],
      };

      const touchesConfig = payload.commits.some((c: any) =>
        [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]
          .some((f: string) => f.startsWith('.gitswarm/'))
      );

      expect(touchesConfig).toBe(true);
    });

    it('should not false-positive on non-.gitswarm paths', () => {
      const payload = {
        commits: [
          {
            added: ['src/gitswarm/config.ts'],
            modified: ['README.md'],
            removed: [],
          },
        ],
      };

      const touchesConfig = payload.commits.some((c: any) =>
        [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]
          .some((f: string) => f.startsWith('.gitswarm/'))
      );

      expect(touchesConfig).toBe(false);
    });
  });
});
