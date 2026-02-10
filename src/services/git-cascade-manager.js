/**
 * Server-Side Git-Cascade Manager (Mode C)
 *
 * Manages server-side repository clones, git-cascade trackers,
 * and per-agent worktrees for Mode C (server-only) deployments.
 *
 * Each repo gets its own:
 *   - Bare or working clone on the server filesystem
 *   - SQLite database for git-cascade state (co-located with the clone)
 *   - MultiAgentRepoTracker instance
 *
 * Design note: git-cascade requires SQLite (better-sqlite3). For Mode C,
 * governance lives in PostgreSQL while git mechanics live in per-repo
 * SQLite databases. This is the "SQLite sidecar" approach from the design
 * doc (section 11, question 1, option c).
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { query } from '../config/database.js';

// git-cascade is an optional dependency for Mode C
let MultiAgentRepoTracker = null;
let Database = null;

try {
  const gc = await import('git-cascade');
  MultiAgentRepoTracker = gc.MultiAgentRepoTracker;
} catch {
  // git-cascade not installed — Mode C unavailable
}

try {
  const sqlite = await import('better-sqlite3');
  Database = sqlite.default;
} catch {
  // better-sqlite3 not installed — Mode C unavailable
}

const DEFAULT_REPOS_DIR = process.env.GITSWARM_REPOS_DIR || '/var/lib/gitswarm/repos';

export class GitCascadeManager {
  /**
   * @param {string} reposDir - Filesystem path for repo clones
   * @param {object} pgQuery - PostgreSQL query function (optional, for reading repo settings)
   */
  constructor(reposDir = DEFAULT_REPOS_DIR, pgQuery = null) {
    this.reposDir = reposDir;
    this.trackers = new Map(); // repoId -> { tracker, db, repoPath }
    this.available = !!(MultiAgentRepoTracker && Database);
    // PostgreSQL query function — used to read repo settings instead of
    // duplicating them in the SQLite sidecar (prevents dual-DB drift).
    this.pgQuery = pgQuery || query;
  }

  /**
   * Check if Mode C is available (git-cascade + better-sqlite3 installed).
   */
  isAvailable() {
    return this.available;
  }

  /**
   * Initialize a repo for server-side management.
   * Clones from remote (or creates an empty repo) and sets up git-cascade.
   *
   * @param {string} repoId - UUID from gitswarm_repos
   * @param {object} opts
   * @param {string} opts.cloneUrl - Git URL to clone from
   * @param {string} opts.bufferBranch - Buffer branch name (default: 'buffer')
   */
  async initRepo(repoId, { cloneUrl, bufferBranch = 'buffer' } = {}) {
    if (!this.available) {
      throw new Error('Mode C unavailable: git-cascade and better-sqlite3 must be installed');
    }

    const repoPath = join(this.reposDir, repoId);

    if (!existsSync(repoPath)) {
      mkdirSync(repoPath, { recursive: true });

      if (cloneUrl) {
        execSync(`git clone "${cloneUrl}" "${repoPath}"`, {
          encoding: 'utf-8',
          timeout: 120000,
        });
      } else {
        execSync('git init', { cwd: repoPath, encoding: 'utf-8' });
        // Create initial commit so branches work
        writeFileSync(join(repoPath, '.gitkeep'), '');
        execSync('git add .gitkeep && git commit -m "Initial commit"', {
          cwd: repoPath,
          encoding: 'utf-8',
        });
      }

      // Create buffer branch if it doesn't exist
      try {
        execSync(`git rev-parse --verify "${bufferBranch}"`, { cwd: repoPath });
      } catch {
        execSync(`git branch "${bufferBranch}"`, { cwd: repoPath, encoding: 'utf-8' });
      }
    }

    // Initialize git-cascade tracker with SQLite sidecar
    const dbPath = join(repoPath, '.gitswarm-cascade.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    const tracker = new MultiAgentRepoTracker({
      repoPath,
      db,
      tablePrefix: 'gc_',
      skipRecovery: false,
    });

    // Track buffer branch
    try {
      tracker.createStream({
        name: `buffer:${bufferBranch}`,
        agentId: 'server',
        existingBranch: bufferBranch,
        createBranch: false,
      });
    } catch {
      // Buffer stream may already exist
    }

    this.trackers.set(repoId, { tracker, db, repoPath });

    return { repoPath, available: true };
  }

  /**
   * Get tracker for a repo (initializes lazily if config exists).
   */
  async getTracker(repoId) {
    if (this.trackers.has(repoId)) {
      return this.trackers.get(repoId);
    }

    // Check if repo has a server-side clone
    const repoPath = join(this.reposDir, repoId);
    const dbPath = join(repoPath, '.gitswarm-cascade.db');

    if (!existsSync(repoPath) || !existsSync(dbPath)) {
      return null;
    }

    // Re-initialize from existing files — always read from PostgreSQL
    const repo = await this.pgQuery(`
      SELECT buffer_branch, clone_url FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) return null;

    await this.initRepo(repoId, {
      bufferBranch: repo.rows[0].buffer_branch || 'buffer',
    });

    return this.trackers.get(repoId);
  }

  /**
   * Create a stream (workspace) for an agent.
   * Server-side equivalent of CLI's createWorkspace.
   */
  async createStream(repoId, { agentId, name, baseBranch, parentStreamId }) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker, repoPath } = ctx;

    let streamId;
    const streamName = name || `${agentId}/${Date.now()}`;

    if (parentStreamId) {
      streamId = tracker.forkStream({
        parentStreamId,
        agentId,
        name: streamName,
      });
    } else {
      streamId = tracker.createStream({
        name: streamName,
        agentId,
        base: baseBranch || 'buffer',
      });
    }

    // Create worktree for the agent
    const worktreeDir = join(repoPath, '.worktrees', agentId);
    const branchName = tracker.getStreamBranchName(streamId);

    let worktree = tracker.getWorktree(agentId);
    if (worktree) {
      tracker.updateWorktreeStream(agentId, streamId);
    } else {
      worktree = tracker.createWorktree({
        agentId,
        path: worktreeDir,
        branch: branchName,
      });
    }

    return {
      streamId,
      branch: branchName,
      worktreePath: worktree.path || worktreeDir,
    };
  }

  /**
   * Write a file to an agent's worktree.
   */
  async writeFile(repoId, agentId, filePath, content) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker } = ctx;
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No worktree for agent: ${agentId}`);

    const fullPath = join(worktree.path, filePath);
    const dir = join(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);

    // Stage the file
    execSync(`git add "${filePath}"`, { cwd: worktree.path, encoding: 'utf-8' });

    return { path: filePath, size: Buffer.byteLength(content) };
  }

  /**
   * Read a file from an agent's worktree.
   */
  async readFile(repoId, agentId, filePath) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker } = ctx;
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No worktree for agent: ${agentId}`);

    const fullPath = join(worktree.path, filePath);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, 'utf-8');
  }

  /**
   * Delete a file from an agent's worktree.
   */
  async deleteFile(repoId, agentId, filePath) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker } = ctx;
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No worktree for agent: ${agentId}`);

    const fullPath = join(worktree.path, filePath);
    if (!existsSync(fullPath)) return { deleted: false };

    unlinkSync(fullPath);
    execSync(`git rm --cached "${filePath}" 2>/dev/null || true`, {
      cwd: worktree.path,
      encoding: 'utf-8',
    });

    return { deleted: true, path: filePath };
  }

  /**
   * List files in an agent's worktree.
   */
  async listFiles(repoId, agentId, dirPath = '.') {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker } = ctx;
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No worktree for agent: ${agentId}`);

    const fullPath = join(worktree.path, dirPath);
    if (!existsSync(fullPath)) return [];

    const entries = readdirSync(fullPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.git'))
      .map(e => ({
        name: e.name,
        path: join(dirPath, e.name).replace(/^\.\//, ''),
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? statSync(join(fullPath, e.name)).size : undefined,
      }));
  }

  /**
   * Commit staged changes in an agent's worktree via git-cascade.
   */
  async commitChanges(repoId, agentId, { message, streamId }) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker } = ctx;
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No worktree for agent: ${agentId}`);

    const sid = streamId || worktree.currentStream;
    if (!sid) throw new Error('No active stream for this worktree');

    const result = tracker.commitChanges({
      streamId: sid,
      agentId,
      worktree: worktree.path,
      message,
    });

    return { commit: result.commit, changeId: result.changeId, streamId: sid };
  }

  /**
   * Merge a stream to buffer (server-side git merge).
   *
   * On conflict, returns structured conflict info instead of throwing,
   * so agents can resolve via the /resolve endpoint.
   */
  async mergeToBuffer(repoId, streamId) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker, repoPath } = ctx;

    const repo = await this.pgQuery(`
      SELECT buffer_branch FROM gitswarm_repos WHERE id = $1
    `, [repoId]);
    const bufferBranch = repo.rows[0]?.buffer_branch || 'buffer';

    const streamBranch = tracker.getStreamBranchName(streamId);

    execSync(`git checkout "${bufferBranch}"`, { cwd: repoPath, encoding: 'utf-8' });
    try {
      execSync(
        `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`,
        { cwd: repoPath, encoding: 'utf-8' }
      );
    } catch (err) {
      // Detect which files conflict before aborting
      const conflicts = this._detectConflicts(repoPath, bufferBranch, streamBranch);
      execSync('git merge --abort', { cwd: repoPath, encoding: 'utf-8' });

      const error = new Error('merge_conflict');
      error.conflicts = conflicts;
      error.streamId = streamId;
      error.bufferBranch = bufferBranch;
      error.streamBranch = streamBranch;
      throw error;
    }

    tracker.updateStream(streamId, { status: 'merged' });
    const mergeCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

    return { mergeCommit, bufferBranch };
  }

  /**
   * Detect conflicting files during a merge and extract both versions.
   * Called while the merge is still in progress (before --abort).
   */
  _detectConflicts(repoPath, bufferBranch, streamBranch) {
    try {
      const output = execSync(
        'git diff --name-only --diff-filter=U',
        { cwd: repoPath, encoding: 'utf-8' }
      );

      const conflictingFiles = output.trim().split('\n').filter(Boolean);

      return conflictingFiles.map(filePath => {
        let ours = '', theirs = '', base = '';
        try {
          ours = execSync(`git show ":2:${filePath}"`, { cwd: repoPath, encoding: 'utf-8' });
        } catch { /* file may not exist in ours */ }
        try {
          theirs = execSync(`git show ":3:${filePath}"`, { cwd: repoPath, encoding: 'utf-8' });
        } catch { /* file may not exist in theirs */ }
        try {
          base = execSync(`git show ":1:${filePath}"`, { cwd: repoPath, encoding: 'utf-8' });
        } catch { /* file may be new */ }

        return { path: filePath, ours, theirs, base };
      });
    } catch {
      return [];
    }
  }

  /**
   * Resolve a merge conflict by applying resolved file contents,
   * then completing the merge.
   *
   * @param {string} repoId
   * @param {string} streamId
   * @param {Array<{path: string, content: string}>} resolutions
   * @returns {{ mergeCommit: string, bufferBranch: string }}
   */
  async resolveConflict(repoId, streamId, resolutions) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { tracker, repoPath } = ctx;

    const repo = await this.pgQuery(`
      SELECT buffer_branch FROM gitswarm_repos WHERE id = $1
    `, [repoId]);
    const bufferBranch = repo.rows[0]?.buffer_branch || 'buffer';
    const streamBranch = tracker.getStreamBranchName(streamId);

    // Start the merge again
    execSync(`git checkout "${bufferBranch}"`, { cwd: repoPath, encoding: 'utf-8' });
    try {
      execSync(
        `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`,
        { cwd: repoPath, encoding: 'utf-8' }
      );
      // If merge succeeds (race condition: conflict was already resolved), we're done
    } catch {
      // Expected: merge has conflicts. Apply resolutions.
      for (const { path: filePath, content } of resolutions) {
        const fullPath = join(repoPath, filePath);
        writeFileSync(fullPath, content);
        execSync(`git add "${filePath}"`, { cwd: repoPath, encoding: 'utf-8' });
      }

      // Complete the merge
      execSync(
        `git commit --no-edit`,
        { cwd: repoPath, encoding: 'utf-8' }
      );
    }

    tracker.updateStream(streamId, { status: 'merged' });
    const mergeCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

    return { mergeCommit, bufferBranch };
  }

  /**
   * Get the current buffer state for a repo.
   *
   * Stabilization runs are the responsibility of external agents, not the
   * server. Agents clone/pull the buffer branch, run tests locally, and
   * report results via POST /repos/:id/server-stabilize (or the Mode B
   * equivalent POST /repos/:id/stabilize).
   *
   * This helper returns the current buffer commit so agents know what
   * they are stabilizing against.
   */
  async getBufferState(repoId) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { repoPath } = ctx;

    const repo = await query(`
      SELECT buffer_branch FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    const bufferBranch = repo.rows[0]?.buffer_branch || 'buffer';

    const bufferCommit = execSync(
      `git rev-parse "${bufferBranch}"`,
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim();

    return { bufferBranch, bufferCommit, repoPath };
  }

  /**
   * Promote buffer to main (fast-forward).
   */
  async promote(repoId) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const { repoPath } = ctx;

    const repo = await this.pgQuery(`
      SELECT buffer_branch, promote_target FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    const { buffer_branch, promote_target } = repo.rows[0];
    const bufferBranch = buffer_branch || 'buffer';
    const target = promote_target || 'main';

    const fromCommit = execSync(`git rev-parse "${bufferBranch}"`, { cwd: repoPath, encoding: 'utf-8' }).trim();

    execSync(`git checkout "${target}"`, { cwd: repoPath, encoding: 'utf-8' });
    execSync(`git merge --ff-only "${bufferBranch}"`, { cwd: repoPath, encoding: 'utf-8' });

    const toCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

    return { fromCommit, toCommit, from: bufferBranch, to: target };
  }

  /**
   * Push to remote (if configured).
   */
  async pushToRemote(repoId, branch) {
    const ctx = await this.getTracker(repoId);
    if (!ctx) return;

    const { repoPath } = ctx;
    try {
      execSync(`git push origin "${branch}"`, { cwd: repoPath, encoding: 'utf-8', timeout: 60000 });
    } catch {
      // Remote may not be configured
    }
  }

  /**
   * Close a tracker and its database.
   */
  closeRepo(repoId) {
    const ctx = this.trackers.get(repoId);
    if (ctx?.db) {
      ctx.db.close();
    }
    this.trackers.delete(repoId);
  }

  /**
   * Close all trackers.
   */
  closeAll() {
    for (const [repoId] of this.trackers) {
      this.closeRepo(repoId);
    }
  }
}

// Singleton
export const gitCascadeManager = new GitCascadeManager();
