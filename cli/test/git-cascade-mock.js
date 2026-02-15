/**
 * In-memory mock of git-cascade's MultiAgentRepoTracker.
 *
 * Provides the same API surface used by Federation without requiring
 * the native git-cascade package. Streams, worktrees, and operations
 * are stored in plain JS maps so integration/e2e tests can exercise
 * the full Federation lifecycle.
 */
import { execSync } from 'child_process';

let _nextId = 1;
function genId() { return `stream-${_nextId++}`; }

export class MultiAgentRepoTracker {
  constructor({ repoPath, db, tablePrefix, skipRecovery } = {}) {
    this.repoPath = repoPath;
    this.db = db;
    this.tablePrefix = tablePrefix || 'gc_';
    this._streams = new Map();     // id → stream object
    this._worktrees = new Map();   // agentId → worktree object
    this._operations = [];         // { streamId, type, ... }
    this._changes = new Map();     // streamId → [change, ...]
  }

  // ── Streams ────────────────────────────────────────────────

  createStream({ name, agentId, base, existingBranch, createBranch = true }) {
    const id = genId();
    const branchName = existingBranch || `gsw/${name.replace(/[^a-zA-Z0-9_/-]/g, '-')}`;

    // Create the git branch if needed
    if (createBranch !== false && !existingBranch && this.repoPath) {
      const baseBranch = base || 'main';
      try {
        execSync(`git branch "${branchName}" "${baseBranch}"`, {
          cwd: this.repoPath, stdio: 'pipe',
        });
      } catch {
        // Branch may already exist
      }
    }

    const stream = {
      id,
      name,
      agentId,
      status: 'active',
      branchName,
      existingBranch: existingBranch || null,
      parentStreamId: null,
      createdAt: new Date().toISOString(),
    };
    this._streams.set(id, stream);
    this._changes.set(id, []);
    return id;
  }

  forkStream({ parentStreamId, agentId, name }) {
    const parent = this._streams.get(parentStreamId);
    if (!parent) throw new Error(`Parent stream not found: ${parentStreamId}`);

    const id = genId();
    const branchName = `gsw/${name.replace(/[^a-zA-Z0-9_/-]/g, '-')}`;

    if (this.repoPath) {
      try {
        execSync(`git branch "${branchName}" "${parent.branchName}"`, {
          cwd: this.repoPath, stdio: 'pipe',
        });
      } catch {
        // Branch may already exist
      }
    }

    const stream = {
      id,
      name,
      agentId,
      status: 'active',
      branchName,
      existingBranch: null,
      parentStreamId,
      createdAt: new Date().toISOString(),
    };
    this._streams.set(id, stream);
    this._changes.set(id, []);
    return id;
  }

  getStream(streamId) {
    return this._streams.get(streamId) || null;
  }

  listStreams(filter = {}) {
    let streams = [...this._streams.values()];
    if (filter.status) {
      streams = streams.filter(s => s.status === filter.status);
    }
    return streams;
  }

  getStreamBranchName(streamId) {
    const s = this._streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    return s.branchName;
  }

  updateStream(streamId, updates) {
    const s = this._streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    Object.assign(s, updates);
    this._operations.push({ streamId, type: 'update', updates, ts: new Date().toISOString() });
  }

  abandonStream(streamId, { reason } = {}) {
    this.updateStream(streamId, { status: 'abandoned' });
    this._operations.push({ streamId, type: 'abandon', reason, ts: new Date().toISOString() });
  }

  getChildStreams(streamId) {
    return [...this._streams.values()].filter(s => s.parentStreamId === streamId);
  }

  getDependencies(streamId) {
    const s = this._streams.get(streamId);
    if (!s || !s.parentStreamId) return [];
    return [this._streams.get(s.parentStreamId)].filter(Boolean);
  }

  // ── Worktrees ──────────────────────────────────────────────

  createWorktree({ agentId, path, branch }) {
    if (this.repoPath) {
      try {
        execSync(`git worktree add "${path}" "${branch}"`, {
          cwd: this.repoPath, stdio: 'pipe',
        });
      } catch {
        // Worktree may already exist or branch issues
      }
    }
    const wt = { agentId, path, currentStream: null, lastActive: new Date().toISOString() };
    // Link to the stream that owns this branch
    for (const [id, s] of this._streams) {
      if (s.branchName === branch) { wt.currentStream = id; break; }
    }
    this._worktrees.set(agentId, wt);
    return wt;
  }

  getWorktree(agentId) {
    return this._worktrees.get(agentId) || null;
  }

  listWorktrees() {
    return [...this._worktrees.values()];
  }

  updateWorktreeStream(agentId, streamId) {
    const wt = this._worktrees.get(agentId);
    if (wt) {
      wt.currentStream = streamId;
      wt.lastActive = new Date().toISOString();
    }
  }

  deallocateWorktree(agentId) {
    const wt = this._worktrees.get(agentId);
    if (wt && this.repoPath) {
      try {
        execSync(`git worktree remove "${wt.path}" --force`, {
          cwd: this.repoPath, stdio: 'pipe',
        });
      } catch {
        // Cleanup best-effort
      }
    }
    this._worktrees.delete(agentId);
  }

  // ── Commits ────────────────────────────────────────────────

  commitChanges({ streamId, agentId, worktree, message }) {
    const changeId = `I${Date.now().toString(36)}`;
    const fullMessage = `${message}\n\nChange-Id: ${changeId}`;

    let commit;
    try {
      execSync(`git add -A`, { cwd: worktree, stdio: 'pipe' });
      execSync(`git commit -m "${fullMessage.replace(/"/g, '\\"')}"`, {
        cwd: worktree, stdio: 'pipe',
      });
      commit = execSync('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      commit = 'mock-commit-' + Date.now().toString(36);
    }

    const change = { changeId, commit, streamId, agentId, message, ts: new Date().toISOString() };
    const changes = this._changes.get(streamId) || [];
    changes.push(change);
    this._changes.set(streamId, changes);

    this._operations.push({ streamId, type: 'commit', commit, changeId, ts: new Date().toISOString() });

    return { commit, changeId };
  }

  // ── Operations & Changes ───────────────────────────────────

  getOperations(filter = {}) {
    if (filter.streamId) {
      return this._operations.filter(o => o.streamId === filter.streamId);
    }
    return [...this._operations];
  }

  getChangesForStream(streamId) {
    return this._changes.get(streamId) || [];
  }

  // ── Stack / Review helpers ─────────────────────────────────

  autoPopulateStack(streamId) {
    // No-op in mock — real impl builds dependency graph
  }

  getStack(streamId) {
    return [streamId];
  }

  rollbackToOperation({ streamId, operationId }) {
    // No-op in mock
  }

  // ── Cleanup ────────────────────────────────────────────────

  close() {
    this._streams.clear();
    this._worktrees.clear();
    this._operations = [];
    this._changes.clear();
  }
}

export default {};
