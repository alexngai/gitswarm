/**
 * GitHub Backend
 *
 * Wraps the existing GitSwarmService (GitHub REST API) behind
 * the GitBackend interface.
 */
import { GitBackend } from './git-backend.js';
import { GitSwarmService, gitswarmService } from './gitswarm.js';

export class GitHubBackend extends GitBackend {
  private service: GitSwarmService;

  constructor(service: GitSwarmService | null = null) {
    super();
    this.service = service || gitswarmService;
  }

  async readFile(repoId: string, path: string, ref?: string): Promise<{ content: string; sha: string; encoding: string; size: number; path: string }> {
    return this.service.getFileContents(repoId, path, ref);
  }

  async listDirectory(repoId: string, path: string, ref?: string): Promise<Array<{ name: string; path: string; type: string; sha: string; size: number }>> {
    return this.service.getDirectoryContents(repoId, path, ref);
  }

  async getTree(repoId: string, ref?: string): Promise<Record<string, any>> {
    return this.service.getTree(repoId, ref);
  }

  async getCommits(repoId: string, options?: Record<string, any>): Promise<Array<Record<string, any>>> {
    return this.service.getCommits(repoId, options);
  }

  async getBranches(repoId: string): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
    return this.service.getBranches(repoId);
  }

  async writeFile(repoId: string, path: string, content: string, message: string, branch: string, author?: { name: string; email: string }): Promise<Record<string, any>> {
    // GitHub's createFile and updateFile both use PUT to /contents
    // Try update first (requires SHA), fall back to create
    try {
      const existing = await this.service.getFileContents(repoId, path, branch);
      return this.service.updateFile(
        repoId, path, content, message, existing.sha, branch,
        author?.name, author?.email
      );
    } catch {
      return this.service.createFile(
        repoId, path, content, message, branch,
        author?.name, author?.email
      );
    }
  }

  async createBranch(repoId: string, name: string, fromSha: string): Promise<Record<string, any>> {
    return this.service.createBranch(repoId, name, fromSha);
  }

  async createPullRequest(repoId: string, prData: any): Promise<Record<string, any>> {
    return this.service.createPullRequest(repoId, prData);
  }

  async mergePullRequest(repoId: string, prNumber: number, options?: Record<string, any>): Promise<Record<string, any>> {
    return this.service.mergePullRequest(repoId, prNumber, options);
  }

  async getCloneAccess(repoId: string): Promise<{ cloneUrl: string; token: string }> {
    const { cloneUrl, token } = await this.service.getRepoWithCloneAccess(repoId);
    return { cloneUrl, token };
  }
}
