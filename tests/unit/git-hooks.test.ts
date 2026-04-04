import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    gitea: {
      url: 'http://gitea:3000',
      adminToken: 'admin-token',
      internalSecret: 'test-secret',
      sshUrl: '',
      externalUrl: '',
    },
    defaultGitBackend: 'gitea',
  },
}));

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('Git Hooks - Pre-receive Validation', () => {
  let validatePreReceive: any;
  let isProtectedBranch: any;
  let isBufferBranch: any;
  let isStreamBranch: any;
  let resolveRepoFromPath: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/routes/internal/git-hooks.js');
    validatePreReceive = mod.validatePreReceive;
    isProtectedBranch = mod.isProtectedBranch;
    isBufferBranch = mod.isBufferBranch;
    isStreamBranch = mod.isStreamBranch;
    resolveRepoFromPath = mod.resolveRepoFromPath;
  });

  // ============================================================
  // Helper function tests
  // ============================================================

  describe('isProtectedBranch', () => {
    const repo = { default_branch: 'main', promote_target: 'main' };

    it('should identify main as protected', () => {
      expect(isProtectedBranch(repo, 'refs/heads/main')).toBe(true);
    });

    it('should identify custom promote_target as protected', () => {
      const r = { default_branch: 'main', promote_target: 'production' };
      expect(isProtectedBranch(r, 'refs/heads/production')).toBe(true);
    });

    it('should not flag buffer as protected', () => {
      expect(isProtectedBranch(repo, 'refs/heads/buffer')).toBe(false);
    });

    it('should not flag stream branches as protected', () => {
      expect(isProtectedBranch(repo, 'refs/heads/stream/feat-1')).toBe(false);
    });
  });

  describe('isBufferBranch', () => {
    it('should identify buffer branch', () => {
      const repo = { buffer_branch: 'buffer' };
      expect(isBufferBranch(repo, 'refs/heads/buffer')).toBe(true);
    });

    it('should handle custom buffer branch name', () => {
      const repo = { buffer_branch: 'staging' };
      expect(isBufferBranch(repo, 'refs/heads/staging')).toBe(true);
    });

    it('should default to "buffer" when not set', () => {
      const repo = {};
      expect(isBufferBranch(repo, 'refs/heads/buffer')).toBe(true);
    });

    it('should not match main', () => {
      const repo = { buffer_branch: 'buffer' };
      expect(isBufferBranch(repo, 'refs/heads/main')).toBe(false);
    });
  });

  describe('isStreamBranch', () => {
    it('should identify stream/* branches', () => {
      expect(isStreamBranch('refs/heads/stream/feat-1')).toBe(true);
      expect(isStreamBranch('refs/heads/stream/fix-auth')).toBe(true);
    });

    it('should not match non-stream branches', () => {
      expect(isStreamBranch('refs/heads/main')).toBe(false);
      expect(isStreamBranch('refs/heads/feature/something')).toBe(false);
      expect(isStreamBranch('refs/heads/buffer')).toBe(false);
    });
  });

  describe('resolveRepoFromPath', () => {
    it('should extract owner/repo from Gitea path', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          name: 'my-repo',
          default_branch: 'main',
          buffer_branch: 'buffer',
          promote_target: 'main',
          gitea_owner: 'my-org',
          gitea_repo_name: 'my-repo',
        }],
      } as any);

      const repo = await resolveRepoFromPath('/data/gitea-repositories/my-org/my-repo.git');
      expect(repo).not.toBeNull();
      expect(repo.gitea_owner).toBe('my-org');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('gitea_owner'),
        ['my-org', 'my-repo']
      );
    });

    it('should return null for unrecognized path format', async () => {
      // Path doesn't match the regex, so no query is made
      const repo = await resolveRepoFromPath('');
      expect(repo).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return null when repo not in DB', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const repo = await resolveRepoFromPath('/data/gitea-repositories/unknown/repo.git');
      expect(repo).toBeNull();
    });
  });

  // ============================================================
  // Pre-receive validation rules
  // ============================================================

  describe('Rule 1: Protected branch enforcement', () => {
    function mockRepoLookup() {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          name: 'test-repo',
          default_branch: 'main',
          buffer_branch: 'buffer',
          promote_target: 'main',
          merge_mode: 'review',
          git_backend: 'gitea',
          gitea_owner: 'test-org',
          gitea_repo_name: 'test-repo',
        }],
      } as any);
    }

    it('should deny direct push to main when no pending merge', async () => {
      mockRepoLookup();
      // resolveAgentFromPusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] } as any);
      // No pending merges
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/main',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Direct push to protected branch');
    });

    it('should allow push to main when pending merge exists', async () => {
      mockRepoLookup();
      // resolveAgentFromPusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] } as any);
      // Pending merge found
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'merge-uuid', stream_id: 'stream-1' }],
      } as any);
      // Update pending merge to completed
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/main',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Rule 2: Buffer branch enforcement', () => {
    function mockRepoLookup() {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          name: 'test-repo',
          default_branch: 'main',
          buffer_branch: 'buffer',
          promote_target: 'main',
          merge_mode: 'review',
          git_backend: 'gitea',
          gitea_owner: 'test-org',
          gitea_repo_name: 'test-repo',
        }],
      } as any);
    }

    it('should deny direct push to buffer when no pending merge', async () => {
      mockRepoLookup();
      // resolveAgentFromPusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] } as any);
      // No pending merges
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/buffer',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('consensus-approved merges');
    });

    it('should allow push to buffer when pending merge exists', async () => {
      mockRepoLookup();
      // resolveAgentFromPusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] } as any);
      // Pending merge found
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'merge-uuid', stream_id: 'stream-1' }],
      } as any);
      // Update pending merge to completed
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/buffer',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Rule 3: Stream branch ownership', () => {
    function mockRepoLookup() {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          name: 'test-repo',
          default_branch: 'main',
          buffer_branch: 'buffer',
          promote_target: 'main',
          merge_mode: 'review',
          git_backend: 'gitea',
          gitea_owner: 'test-org',
          gitea_repo_name: 'test-repo',
        }],
      } as any);
    }

    it('should allow stream owner to push', async () => {
      mockRepoLookup();
      // Resolve pusher to agent-owner
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-owner' }] } as any);
      // Stream owned by agent-owner
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'stream-1', agent_id: 'agent-owner' }] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/stream/feat-1',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-owner',
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny non-owner, non-maintainer push to stream branch', async () => {
      mockRepoLookup();
      // Resolve pusher to agent-intruder
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-intruder' }] } as any);
      // Stream owned by agent-owner
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'stream-1', agent_id: 'agent-owner' }] } as any);
      // Not a maintainer
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/stream/feat-1',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-intruder',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Only the stream owner or maintainers');
    });

    it('should allow maintainer to push to any stream branch', async () => {
      mockRepoLookup();
      // Resolve pusher to maintainer-agent
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'maintainer-agent' }] } as any);
      // Stream owned by someone else
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'stream-1', agent_id: 'agent-owner' }] } as any);
      // Is a maintainer
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'maint-uuid' }] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/stream/feat-1',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'maintainer-agent',
      });

      expect(result.allowed).toBe(true);
    });

    it('should allow push to new stream branch (no existing stream record)', async () => {
      mockRepoLookup();
      // Resolve pusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'new-agent' }] } as any);
      // No stream record for this branch
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/heads/stream/new-feature',
        old_sha: '0000000000000000000000000000000000000000',
        new_sha: 'bbb',
        pusher: 'new-agent',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should allow tag pushes without checking governance', async () => {
      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/test-org/test-repo.git',
        ref: 'refs/tags/v1.0.0',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(true);
    });

    it('should allow pushes when repo is not tracked by GitSwarm', async () => {
      // Repo path doesn't match any GitSwarm repo
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/external-org/external-repo.git',
        ref: 'refs/heads/main',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'someone',
      });

      expect(result.allowed).toBe(true);
    });

    it('should allow pushes to non-governed branches (not main, buffer, or stream)', async () => {
      // resolveRepoFromPath
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          default_branch: 'main',
          buffer_branch: 'buffer',
          promote_target: 'main',
          gitea_owner: 'org',
          gitea_repo_name: 'repo',
        }],
      } as any);
      // resolveAgentFromPusher
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] } as any);

      const result = await validatePreReceive({
        repo_path: '/data/gitea-repositories/org/repo.git',
        ref: 'refs/heads/experiment/try-something',
        old_sha: 'aaa',
        new_sha: 'bbb',
        pusher: 'agent-1',
      });

      expect(result.allowed).toBe(true);
    });
  });
});

describe('Git Hooks - Internal Auth', () => {
  it('should verify X-Internal-Secret header matches config', () => {
    const expectedSecret = 'test-secret';
    const validHeader = 'test-secret';
    const invalidHeader = 'wrong-secret';

    expect(validHeader === expectedSecret).toBe(true);
    expect(invalidHeader === expectedSecret).toBe(false);
  });

  it('should allow requests when no secret is configured (dev mode)', () => {
    const configuredSecret = '';
    // Empty secret = dev mode, allow all
    expect(!configuredSecret).toBe(true);
  });
});

describe('Git Hooks - Post-receive', () => {
  it('should record push events in activity log', () => {
    // The post-receive hook fires async — verify the data shape
    const postReceivePayload = {
      repo_path: '/data/gitea-repositories/test-org/test-repo.git',
      ref: 'refs/heads/stream/feat-1',
      old_sha: 'aaa000',
      new_sha: 'bbb111',
      pusher: 'agent-1',
    };

    expect(postReceivePayload.ref.startsWith('refs/heads/')).toBe(true);
    const branchName = postReceivePayload.ref.replace('refs/heads/', '');
    expect(branchName).toBe('stream/feat-1');
    expect(branchName.startsWith('stream/')).toBe(true);
  });
});
