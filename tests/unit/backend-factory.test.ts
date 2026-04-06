import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all backends and the database
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/services/github-backend.js', () => ({
  GitHubBackend: vi.fn().mockImplementation(() => ({ type: 'github' })),
}));

vi.mock('../../src/services/cascade-backend.js', () => ({
  CascadeBackend: vi.fn().mockImplementation(() => ({ type: 'cascade' })),
}));

vi.mock('../../src/services/gitea-backend.js', () => ({
  GiteaBackend: vi.fn().mockImplementation(() => ({ type: 'gitea' })),
}));

import { query } from '../../src/config/database.js';
const mockQuery = vi.mocked(query);

describe('Backend Factory', () => {
  let getBackendForRepo: any;
  let getBackend: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/services/backend-factory.js');
    getBackendForRepo = mod.getBackendForRepo;
    getBackend = mod.getBackend;
  });

  describe('getBackendForRepo', () => {
    it('should return GitHubBackend for github repos', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ git_backend: 'github' }] } as any);
      const backend = await getBackendForRepo('repo-1');
      expect((backend as any).type).toBe('github');
    });

    it('should return CascadeBackend for cascade repos', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ git_backend: 'cascade' }] } as any);
      const backend = await getBackendForRepo('repo-2');
      expect((backend as any).type).toBe('cascade');
    });

    it('should return GiteaBackend for gitea repos', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ git_backend: 'gitea' }] } as any);
      const backend = await getBackendForRepo('repo-3');
      expect((backend as any).type).toBe('gitea');
    });

    it('should default to GitHubBackend when git_backend is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ git_backend: null }] } as any);
      const backend = await getBackendForRepo('repo-4');
      expect((backend as any).type).toBe('github');
    });

    it('should default to GitHubBackend when repo not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);
      const backend = await getBackendForRepo('nonexistent');
      expect((backend as any).type).toBe('github');
    });
  });

  describe('getBackend', () => {
    it('should return GitHubBackend by name', () => {
      expect((getBackend('github') as any).type).toBe('github');
    });

    it('should return CascadeBackend by name', () => {
      expect((getBackend('cascade') as any).type).toBe('cascade');
    });

    it('should return GiteaBackend by name', () => {
      expect((getBackend('gitea') as any).type).toBe('gitea');
    });

    it('should throw for unknown backend name', () => {
      expect(() => getBackend('invalid')).toThrow('Unknown backend: invalid');
    });
  });
});
