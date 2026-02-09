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

export class GitBackend {
  /**
   * Read a file from the repository.
   * @param {string} repoId
   * @param {string} path
   * @param {string} [ref] - Branch or commit
   * @returns {Promise<{content: string, path: string, sha?: string}>}
   */
  async readFile(repoId, path, ref) {
    throw new Error('readFile not implemented');
  }

  /**
   * List directory contents.
   * @param {string} repoId
   * @param {string} path
   * @param {string} [ref]
   * @returns {Promise<Array<{name: string, path: string, type: string}>>}
   */
  async listDirectory(repoId, path, ref) {
    throw new Error('listDirectory not implemented');
  }

  /**
   * Get recursive tree.
   * @param {string} repoId
   * @param {string} [ref]
   * @returns {Promise<{tree: Array<{path: string, type: string}>}>}
   */
  async getTree(repoId, ref) {
    throw new Error('getTree not implemented');
  }

  /**
   * Get commit history.
   * @param {string} repoId
   * @param {object} [options]
   * @returns {Promise<Array<{sha: string, message: string, author: object}>>}
   */
  async getCommits(repoId, options) {
    throw new Error('getCommits not implemented');
  }

  /**
   * List branches.
   * @param {string} repoId
   * @returns {Promise<Array<{name: string, sha: string}>>}
   */
  async getBranches(repoId) {
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
  async writeFile(repoId, path, content, message, branch, author) {
    throw new Error('writeFile not implemented');
  }

  /**
   * Create a branch.
   * @param {string} repoId
   * @param {string} name
   * @param {string} fromRef
   * @returns {Promise<object>}
   */
  async createBranch(repoId, name, fromRef) {
    throw new Error('createBranch not implemented');
  }

  /**
   * Create a pull request / merge request.
   * @param {string} repoId
   * @param {object} prData - { title, body, head, base }
   * @returns {Promise<object>}
   */
  async createPullRequest(repoId, prData) {
    throw new Error('createPullRequest not implemented');
  }

  /**
   * Merge a pull request.
   * @param {string} repoId
   * @param {number|string} prNumberOrStreamId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async mergePullRequest(repoId, prNumberOrStreamId, options) {
    throw new Error('mergePullRequest not implemented');
  }

  /**
   * Get clone URL with authentication.
   * @param {string} repoId
   * @returns {Promise<{cloneUrl: string, token?: string}>}
   */
  async getCloneAccess(repoId) {
    throw new Error('getCloneAccess not implemented');
  }
}
