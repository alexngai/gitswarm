import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    gitea: {
      url: 'http://gitea:3000',
      adminToken: 'admin-token',
      internalSecret: 'secret',
      sshUrl: 'ssh://git@localhost:2222',
      externalUrl: 'http://localhost:3001',
    },
    defaultGitBackend: 'gitea',
  },
}));

vi.mock('../../src/services/gitea-admin.js', () => ({
  giteaAdmin: {
    buildCloneUrl: vi.fn((owner: string, repo: string, token?: string) => {
      if (token) return `http://x-access-token:${token}@gitea:3000/${owner}/${repo}.git`;
      return `http://gitea:3000/${owner}/${repo}.git`;
    }),
  },
  GiteaAdmin: vi.fn(),
}));

const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('GiteaBackend', () => {
  let GiteaBackend: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const mod = await import('../../src/services/gitea-backend.js');
    GiteaBackend = mod.GiteaBackend;
  });

  function mockRepoLookup(gitea_owner = 'test-org', gitea_repo_name = 'test-repo') {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        gitea_owner,
        gitea_repo_name,
        gitea_repo_id: 42,
        org_id: 'org-uuid',
      }],
    } as any);
  }

  function mockFetchResponse(status: number, body: any) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  describe('readFile', () => {
    it('should fetch file contents from Gitea and decode base64', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      const base64Content = Buffer.from('hello world', 'utf-8').toString('base64');
      mockFetchResponse(200, {
        content: base64Content,
        encoding: 'base64',
        path: 'README.md',
        sha: 'abc123',
      });

      const result = await backend.readFile('repo-uuid', 'README.md');

      expect(result.content).toBe('hello world');
      expect(result.path).toBe('README.md');
      expect(result.sha).toBe('abc123');
    });

    it('should pass ref parameter when provided', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(200, { content: '', encoding: 'base64', path: 'f.txt', sha: 'x' });

      await backend.readFile('repo-uuid', 'f.txt', 'develop');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('?ref=develop'),
        expect.any(Object)
      );
    });

    it('should throw when repo not found in database', async () => {
      const backend = new GiteaBackend();
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      await expect(backend.readFile('bad-id', 'file.txt')).rejects.toThrow('Repository not found');
    });

    it('should throw when repo has no Gitea config', async () => {
      const backend = new GiteaBackend();
      mockQuery.mockResolvedValueOnce({
        rows: [{ gitea_owner: null, gitea_repo_name: null, gitea_repo_id: null, org_id: 'x' }],
      } as any);

      await expect(backend.readFile('repo-uuid', 'file.txt')).rejects.toThrow('not configured for Gitea');
    });
  });

  describe('listDirectory', () => {
    it('should return directory entries', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      mockFetchResponse(200, [
        { name: 'src', path: 'src', type: 'dir', sha: 'a', size: 0 },
        { name: 'README.md', path: 'README.md', type: 'file', sha: 'b', size: 100 },
      ]);

      const result = await backend.listDirectory('repo-uuid', '');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'src', path: 'src', type: 'dir' });
      expect(result[1]).toEqual({ name: 'README.md', path: 'README.md', type: 'file' });
    });
  });

  describe('getBranches', () => {
    it('should return branches with name and sha', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      mockFetchResponse(200, [
        { name: 'main', commit: { id: 'sha-main' }, protected: true },
        { name: 'buffer', commit: { id: 'sha-buffer' }, protected: false },
        { name: 'stream/feat-1', commit: { id: 'sha-feat' }, protected: false },
      ]);

      const result = await backend.getBranches('repo-uuid');

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'main', sha: 'sha-main' });
      expect(result[1]).toEqual({ name: 'buffer', sha: 'sha-buffer' });
    });
  });

  describe('getCommits', () => {
    it('should return normalized commit objects', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      mockFetchResponse(200, [
        {
          sha: 'abc123',
          commit: {
            message: 'initial commit',
            author: { name: 'agent-1', email: 'a@b.com' },
            committer: { name: 'agent-1', email: 'a@b.com' },
          },
          html_url: 'http://gitea/commit/abc123',
        },
      ]);

      const result = await backend.getCommits('repo-uuid');

      expect(result).toHaveLength(1);
      expect(result[0].sha).toBe('abc123');
      expect(result[0].message).toBe('initial commit');
    });

    it('should pass options as query params', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(200, []);

      await backend.getCommits('repo-uuid', { sha: 'develop', per_page: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('sha=develop'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      );
    });
  });

  describe('writeFile', () => {
    it('should create new file when it does not exist', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      // getFileContents returns 404 (file doesn't exist)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });

      // createFile succeeds
      mockFetchResponse(201, { content: { sha: 'new-sha' } });

      await backend.writeFile('repo-uuid', 'new-file.txt', 'content', 'add file', 'main');

      // Second call should be POST (create)
      expect(mockFetch.mock.calls[1][1].method).toBe('POST');
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.content).toBe(Buffer.from('content').toString('base64'));
      expect(body.message).toBe('add file');
      expect(body.branch).toBe('main');
    });

    it('should update existing file with sha', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      // getFileContents returns existing file
      mockFetchResponse(200, { sha: 'existing-sha' });

      // updateFile succeeds
      mockFetchResponse(200, { content: { sha: 'updated-sha' } });

      await backend.writeFile('repo-uuid', 'existing.txt', 'new content', 'update', 'main');

      // Second call should be PUT (update)
      expect(mockFetch.mock.calls[1][1].method).toBe('PUT');
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.sha).toBe('existing-sha');
    });

    it('should include author info when provided', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });
      mockFetchResponse(201, { content: { sha: 'new' } });

      await backend.writeFile('repo-uuid', 'f.txt', 'c', 'msg', 'main', {
        name: 'agent-1',
        email: 'agent-1@gitswarm.local',
      });

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.author).toEqual({ name: 'agent-1', email: 'agent-1@gitswarm.local' });
      expect(body.committer).toEqual({ name: 'agent-1', email: 'agent-1@gitswarm.local' });
    });
  });

  describe('createBranch', () => {
    it('should POST to branches endpoint with correct payload', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(201, { name: 'stream/feat-1' });

      await backend.createBranch('repo-uuid', 'stream/feat-1', 'main');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.new_branch_name).toBe('stream/feat-1');
      expect(body.old_branch_name).toBe('main');
    });
  });

  describe('createPullRequest', () => {
    it('should POST to pulls endpoint', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(201, { number: 1, title: 'feat: new feature' });

      await backend.createPullRequest('repo-uuid', {
        title: 'feat: new feature',
        body: 'Description',
        head: 'stream/feat-1',
        base: 'buffer',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe('feat: new feature');
      expect(body.head).toBe('stream/feat-1');
      expect(body.base).toBe('buffer');
    });
  });

  describe('mergePullRequest', () => {
    it('should POST to merge endpoint with merge method', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(200, { sha: 'merge-sha' });

      await backend.mergePullRequest('repo-uuid', 42, { merge_method: 'squash' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/pulls/42/merge'),
        expect.any(Object)
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.Do).toBe('squash');
    });

    it('should default to merge method', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();
      mockFetchResponse(200, { sha: 'merge-sha' });

      await backend.mergePullRequest('repo-uuid', 1);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.Do).toBe('merge');
    });
  });

  describe('getCloneAccess', () => {
    it('should return clone URL with admin token', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      const result = await backend.getCloneAccess('repo-uuid');

      expect(result.cloneUrl).toContain('test-org/test-repo.git');
      expect(result.token).toBe('admin-token');
    });
  });

  describe('getCloneAccessForAgent', () => {
    it('should use agent-specific Gitea token when available', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      // Agent token lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ gitea_token_hash: 'agent-specific-token' }],
      } as any);

      const result = await backend.getCloneAccessForAgent('repo-uuid', 'agent-uuid');

      expect(result.cloneUrl).toContain('agent-specific-token');
      expect(result.token).toBe('agent-specific-token');
    });

    it('should fall back to admin token when agent has no Gitea mapping', async () => {
      const backend = new GiteaBackend();
      mockRepoLookup();

      // No agent token
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const result = await backend.getCloneAccessForAgent('repo-uuid', 'agent-uuid');

      expect(result.token).toBe('admin-token');
    });
  });
});
