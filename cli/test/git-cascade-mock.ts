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
function genId(): string { return `stream-${_nextId++}`; }

interface StreamData {
  id: string;
  name: string;
  agentId: string;
  status: string;
  branchName: string;
  existingBranch: string | null;
  parentStreamId: string | null;
  createdAt: string;
}

interface WorktreeData {
  agentId: string;
  path: string;
  currentStream: string | null;
  lastActive: string;
}

interface OperationData {
  streamId: string;
  type: string;
  [key: string]: any;
}

interface ChangeData {
  changeId: string;
  commit: string;
  streamId: string;
  agentId: string;
  message: string;
  ts: string;
}

export class MultiAgentRepoTracker {
  repoPath: string | undefined;
  db: any;
  tablePrefix: string;
  _streams: Map<string, StreamData>;
  _worktrees: Map<string, WorktreeData>;
  _operations: OperationData[];
  _changes: Map<string, ChangeData[]>;

  constructor({ repoPath, db, tablePrefix, skipRecovery }: { repoPath?: string; db?: any; tablePrefix?: string; skipRecovery?: boolean } = {}) {
    this.repoPath = repoPath;
    this.db = db;
    this.tablePrefix = tablePrefix || 'gc_';
    this._streams = new Map();
    this._worktrees = new Map();
    this._operations = [];
    this._changes = new Map();
  }

  // ── Streams ────────────────────────────────────────────────

  createStream({ name, agentId, base, existingBranch, createBranch = true }: { name: string; agentId: string; base?: string; existingBranch?: string; createBranch?: boolean }): string {
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

  forkStream({ parentStreamId, agentId, name }: { parentStreamId: string; agentId: string; name: string }): string {
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

  getStream(streamId: string): StreamData | null {
    return this._streams.get(streamId) || null;
  }

  listStreams(filter: { status?: string } = {}): StreamData[] {
    let streams = [...this._streams.values()];
    if (filter.status) {
      streams = streams.filter(s => s.status === filter.status);
    }
    return streams;
  }

  getStreamBranchName(streamId: string): string {
    const s = this._streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    return s.branchName;
  }

  updateStream(streamId: string, updates: Partial<StreamData>): void {
    const s = this._streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    Object.assign(s, updates);
    this._operations.push({ streamId, type: 'update', updates, ts: new Date().toISOString() });
  }

  abandonStream(streamId: string, { reason }: { reason?: string } = {}): void {
    this.updateStream(streamId, { status: 'abandoned' });
    this._operations.push({ streamId, type: 'abandon', reason, ts: new Date().toISOString() });
  }

  getChildStreams(streamId: string): StreamData[] {
    return [...this._streams.values()].filter(s => s.parentStreamId === streamId);
  }

  getDependencies(streamId: string): StreamData[] {
    const s = this._streams.get(streamId);
    if (!s || !s.parentStreamId) return [];
    return [this._streams.get(s.parentStreamId)].filter(Boolean);
  }

  // ── Worktrees ──────────────────────────────────────────────

  createWorktree({ agentId, path, branch }: { agentId: string; path: string; branch: string }): WorktreeData {
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

  getWorktree(agentId: string): WorktreeData | null {
    return this._worktrees.get(agentId) || null;
  }

  listWorktrees(): WorktreeData[] {
    return [...this._worktrees.values()];
  }

  updateWorktreeStream(agentId: string, streamId: string): void {
    const wt = this._worktrees.get(agentId);
    if (wt) {
      wt.currentStream = streamId;
      wt.lastActive = new Date().toISOString();
    }
  }

  deallocateWorktree(agentId: string): void {
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

  commitChanges({ streamId, agentId, worktree, message }: { streamId: string; agentId: string; worktree: string; message: string }): { commit: string; changeId: string } {
    const changeId = `I${Date.now().toString(36)}`;
    const fullMessage = `${message}\n\nChange-Id: ${changeId}`;

    let commit: string;
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

  getOperations(filter: { streamId?: string } = {}): OperationData[] {
    if (filter.streamId) {
      return this._operations.filter(o => o.streamId === filter.streamId);
    }
    return [...this._operations];
  }

  getChangesForStream(streamId: string): ChangeData[] {
    return this._changes.get(streamId) || [];
  }

  // ── Stack / Review helpers ─────────────────────────────────

  autoPopulateStack(_streamId: string): void {
    // No-op in mock — real impl builds dependency graph
  }

  getStack(streamId: string): string[] {
    return [streamId];
  }

  rollbackToOperation({ streamId, operationId }: { streamId: string; operationId: string }): void {
    // No-op in mock
  }

  // ── Cleanup ────────────────────────────────────────────────

  close(): void {
    this._streams.clear();
    this._worktrees.clear();
    this._operations = [];
    this._changes.clear();
  }
}

export default {};
