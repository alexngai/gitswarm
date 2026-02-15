/**
 * Git Backend Interface
 *
 * Abstract interface for git operations. Routes call this instead of
 * directly using GitSwarmService (GitHub API) or GitCascadeManager.
 *
 * Two concrete implementations:
 *   - GitHubBackend: delegates to GitHub REST API (existing repos, no git-cascade)
 *   - CascadeBackend: delegates to server-side git-cascade (Mode C repos)
 *
 * Selection is per-repo via the `git_backend` column in gitswarm_repos.
 */

interface FileResult {
  content: string;
  path: string;
  sha?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: string;
}

interface TreeResult {
  tree: Array<{ path: string; type: string }>;
}

interface CommitResult {
  sha: string;
  message: string;
  author: Record<string, any>;
}

interface BranchResult {
  name: string;
  sha: string;
}

interface WriteResult {
  commit: Record<string, any>;
}

interface PullRequestData {
  title: string;
  body: string;
  head: string;
  base?: string;
}

interface CloneAccessResult {
  cloneUrl: string;
  token?: string;
}

export class GitBackend {
  /**
   * Read a file from the repository.
   * @param {string} repoId
   * @param {string} path
   * @param {string} [ref] - Branch or commit
   * @returns {Promise<{content: string, path: string, sha?: string}>}
   */
  async readFile(repoId: string, path: string, ref?: string): Promise<FileResult> {
    throw new Error('readFile not implemented');
  }

  /**
   * List directory contents.
   * @param {string} repoId
   * @param {string} path
   * @param {string} [ref]
   * @returns {Promise<Array<{name: string, path: string, type: string}>>}
   */
  async listDirectory(repoId: string, path: string, ref?: string): Promise<DirectoryEntry[]> {
    throw new Error('listDirectory not implemented');
  }

  /**
   * Get recursive tree.
   * @param {string} repoId
   * @param {string} [ref]
   * @returns {Promise<{tree: Array<{path: string, type: string}>}>}
   */
  async getTree(repoId: string, ref?: string): Promise<any> {
    throw new Error('getTree not implemented');
  }

  /**
   * Get commit history.
   * @param {string} repoId
   * @param {object} [options]
   * @returns {Promise<Array<{sha: string, message: string, author: object}>>}
   */
  async getCommits(repoId: string, options?: Record<string, any>): Promise<any[]> {
    throw new Error('getCommits not implemented');
  }

  /**
   * List branches.
   * @param {string} repoId
   * @returns {Promise<Array<{name: string, sha: string}>>}
   */
  async getBranches(repoId: string): Promise<BranchResult[]> {
    throw new Error('getBranches not implemented');
  }

  /**
   * Write/create a file (single-file commit).
   * @param {string} repoId
   * @param {string} path
   * @param {string} content
   * @param {string} message - Commit message
   * @param {string} branch
   * @param {object} [author] - { name, email }
   * @returns {Promise<{commit: object}>}
   */
  async writeFile(repoId: string, path: string, content: string, message: string, branch: string, author?: { name: string; email: string }): Promise<any> {
    throw new Error('writeFile not implemented');
  }

  /**
   * Create a branch.
   * @param {string} repoId
   * @param {string} name
   * @param {string} fromRef
   * @returns {Promise<object>}
   */
  async createBranch(repoId: string, name: string, fromRef: string): Promise<Record<string, any>> {
    throw new Error('createBranch not implemented');
  }

  /**
   * Create a pull request / merge request.
   * @param {string} repoId
   * @param {object} prData - { title, body, head, base }
   * @returns {Promise<object>}
   */
  async createPullRequest(repoId: string, prData: any): Promise<Record<string, any>> {
    throw new Error('createPullRequest not implemented');
  }

  /**
   * Merge a pull request.
   * @param {string} repoId
   * @param {number|string} prNumberOrStreamId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async mergePullRequest(repoId: string, prNumberOrStreamId: number | string, options?: Record<string, any>): Promise<Record<string, any>> {
    throw new Error('mergePullRequest not implemented');
  }

  /**
   * Get clone URL with authentication.
   * @param {string} repoId
   * @returns {Promise<{cloneUrl: string, token?: string}>}
   */
  async getCloneAccess(repoId: string): Promise<CloneAccessResult> {
    throw new Error('getCloneAccess not implemented');
  }
}
