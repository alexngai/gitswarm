/**
 * GitHub Backend
 *
 * Wraps the existing GitSwarmService (GitHub REST API) behind
 * the GitBackend interface.
 */
import { GitBackend } from './git-backend.js';
import { GitSwarmService, gitswarmService } from './gitswarm.js';

export class GitHubBackend extends GitBackend {
  constructor(service = null) {
    super();
    this.service = service || gitswarmService;
  }

  async readFile(repoId, path, ref) {
    return this.service.getFileContents(repoId, path, ref);
  }

  async listDirectory(repoId, path, ref) {
    return this.service.getDirectoryContents(repoId, path, ref);
  }

  async getTree(repoId, ref) {
    return this.service.getTree(repoId, ref);
  }

  async getCommits(repoId, options) {
    return this.service.getCommits(repoId, options);
  }

  async getBranches(repoId) {
    return this.service.getBranches(repoId);
  }

  async writeFile(repoId, path, content, message, branch, author) {
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

  async createBranch(repoId, name, fromSha) {
    return this.service.createBranch(repoId, name, fromSha);
  }

  async createPullRequest(repoId, prData) {
    return this.service.createPullRequest(repoId, prData);
  }

  async mergePullRequest(repoId, prNumber, options) {
    return this.service.mergePullRequest(repoId, prNumber, options);
  }

  async getCloneAccess(repoId) {
    const { cloneUrl, token } = await this.service.getRepoWithCloneAccess(repoId);
    return { cloneUrl, token };
  }
}
