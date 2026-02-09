/**
 * Federation — the top-level context for a local gitswarm instance.
 *
 * Encapsulates the SQLite store, git-cascade tracker, and all core services.
 * Every CLI command receives a Federation instance so it can access agents,
 * workspaces, tasks, reviews, council governance, etc.
 *
 * git-cascade owns git mechanics (streams, worktrees, merging, conflicts).
 * gitswarm owns policy (identity, permissions, consensus, governance).
 *
 * Usage:
 *   const fed = Federation.open('/path/to/repo');
 *   const agents = await fed.listAgents();
 *   const { streamId, path } = await fed.createWorkspace({ agentId: agents[0].id });
 *   fed.close();
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { MultiAgentRepoTracker } from 'git-cascade';
import { SqliteStore } from './store/sqlite.js';
import { PermissionService } from './core/permissions.js';
import { TaskService } from './core/tasks.js';
import { CouncilService } from './core/council.js';
import { StageService } from './core/stages.js';
import { ActivityService } from './core/activity.js';

const GITSWARM_DIR = '.gitswarm';
const DB_FILE = 'federation.db';
const CONFIG_FILE = 'config.json';
const WORKTREE_DIR = '.worktrees';

export class Federation {
  constructor(repoPath, store) {
    this.repoPath = repoPath;
    this.swarmDir = join(repoPath, GITSWARM_DIR);
    this.store = store;

    // Core services
    this.permissions = new PermissionService(store);
    this.tasks       = new TaskService(store);
    this.council     = new CouncilService(store);
    this.stages      = new StageService(store);
    this.activity    = new ActivityService(store);

    // Give council a back-reference so it can delegate git ops
    this.council.federation = this;

    // git-cascade tracker — initialized lazily via _ensureTracker()
    this.tracker = null;
  }

  /**
   * Initialize the git-cascade tracker.
   * Shares the same SQLite database instance with gc_ table prefix.
   */
  _ensureTracker() {
    if (this.tracker) return this.tracker;
    this.tracker = new MultiAgentRepoTracker({
      repoPath: this.repoPath,
      db: this.store.db,
      tablePrefix: 'gc_',
      skipRecovery: false,
    });
    return this.tracker;
  }

  /**
   * Open an existing federation at the given repo path.
   * Looks for `.gitswarm/federation.db` up the directory tree.
   */
  static open(startPath = process.cwd()) {
    const swarmDir = Federation.findSwarmDir(startPath);
    if (!swarmDir) {
      throw new Error(
        'Not a gitswarm federation.  Run `gitswarm init` inside a git repository.'
      );
    }
    const dbPath = join(swarmDir, DB_FILE);
    const store = new SqliteStore(dbPath);
    store.migrate();
    const fed = new Federation(join(swarmDir, '..'), store);
    fed._ensureTracker();
    return fed;
  }

  /**
   * Initialize a new federation in the given repo path.
   */
  static init(repoPath, options = {}) {
    const swarmDir = join(repoPath, GITSWARM_DIR);

    if (existsSync(join(swarmDir, DB_FILE))) {
      throw new Error('Federation already initialised in this repository.');
    }

    const dbPath = join(swarmDir, DB_FILE);
    const store = new SqliteStore(dbPath);
    store.migrate();

    const mergeMode = options.merge_mode || 'review';

    // Write default config
    const config = {
      name: options.name || repoPath.split('/').pop(),
      merge_mode: mergeMode,
      ownership_model: options.ownership_model || 'solo',
      agent_access: options.agent_access || 'public',
      consensus_threshold: options.consensus_threshold ?? 0.66,
      min_reviews: options.min_reviews ?? 1,
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(swarmDir, CONFIG_FILE), JSON.stringify(config, null, 2));

    // Create the repo record
    store.query(
      `INSERT INTO repos (name, path, merge_mode, ownership_model, agent_access, consensus_threshold, min_reviews,
         buffer_branch, promote_target, stabilize_command)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.name, repoPath, mergeMode, config.ownership_model, config.agent_access,
        config.consensus_threshold, config.min_reviews,
        options.buffer_branch || 'buffer',
        options.promote_target || 'main',
        options.stabilize_command || null,
      ]
    );

    const fed = new Federation(repoPath, store);
    fed._ensureTracker();

    // Create the buffer branch from current HEAD (if git repo has commits)
    const bufferBranch = options.buffer_branch || 'buffer';
    try {
      const hasCommits = _git(repoPath, 'git rev-parse HEAD');
      if (hasCommits) {
        const branchExists = _gitSafe(repoPath, `git rev-parse --verify ${bufferBranch}`);
        if (!branchExists) {
          _git(repoPath, `git branch "${bufferBranch}"`);
        }
        // Track the buffer branch in git-cascade
        fed.tracker.trackExistingBranch({
          branchName: bufferBranch,
          agentId: 'federation',
          name: `buffer:${bufferBranch}`,
        });
      }
    } catch {
      // Empty repo, no commits yet — buffer will be created on first merge
    }

    return { federation: fed, config };
  }

  /** Read the `.gitswarm/config.json`. */
  config() {
    const p = join(this.swarmDir, CONFIG_FILE);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  /** Get the single repo record (local federations have one repo). */
  async repo() {
    const r = await this.store.query(`SELECT * FROM repos LIMIT 1`);
    return r.rows[0] || null;
  }

  // ── Agent helpers ──────────────────────────────────────────

  async registerAgent(name, description = '') {
    const apiKey = this._generateKey();
    const hash = this._hashKey(apiKey);
    const result = await this.store.query(
      `INSERT INTO agents (name, description, api_key_hash) VALUES (?, ?, ?) RETURNING *`,
      [name, description, hash]
    );
    return { agent: result.rows[0], api_key: apiKey };
  }

  async listAgents() {
    return (await this.store.query(
      `SELECT id, name, description, karma, status, created_at FROM agents ORDER BY created_at`
    )).rows;
  }

  async getAgent(idOrName) {
    let r = await this.store.query(
      `SELECT * FROM agents WHERE id = ? OR name = ?`, [idOrName, idOrName]
    );
    return r.rows[0] || null;
  }

  async resolveAgent(idOrName) {
    const agent = await this.getAgent(idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    return agent;
  }

  // ── Workspace management (git-cascade streams + worktrees) ──

  /**
   * Create an isolated workspace for an agent.
   *
   * Creates a git-cascade stream (branched from buffer or from another stream)
   * and a dedicated worktree directory.
   *
   * @param {object} opts
   * @param {string} opts.agentId - Agent identifier
   * @param {string} [opts.taskId] - Link to a task claim
   * @param {string} [opts.dependsOn] - Fork from this stream instead of buffer
   * @param {string} [opts.name] - Human-readable stream name
   * @returns {{ streamId: string, path: string }}
   */
  async createWorkspace(opts) {
    const { agentId, taskId, dependsOn, name } = opts;
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    // Check permissions
    const { allowed } = await this.permissions.canPerform(agentId, repo.id, 'write');
    if (!allowed) throw new Error('Insufficient permissions to create workspace');

    const tracker = this._ensureTracker();

    let streamId;
    const streamName = name || `${agentId}/${taskId || Date.now()}`;

    if (dependsOn) {
      // Fork from another agent's stream
      streamId = tracker.forkStream({
        parentStreamId: dependsOn,
        agentId,
        name: streamName,
      });
    } else {
      // Branch from buffer (or main if no buffer yet)
      streamId = tracker.createStream({
        name: streamName,
        agentId,
        base: repo.buffer_branch || 'buffer',
      });
    }

    // Create worktree
    const worktreePath = join(this.repoPath, WORKTREE_DIR, `${agentId}`);
    const branchName = tracker.getStreamBranchName(streamId);

    let worktree = tracker.getWorktree(agentId);
    if (worktree) {
      // Agent already has a worktree, switch it to the new stream
      tracker.updateWorktreeStream(agentId, streamId);
    } else {
      worktree = tracker.createWorktree({
        agentId,
        path: worktreePath,
        branch: branchName,
      });
    }

    // Link to task claim if provided
    if (taskId) {
      const claim = await this.tasks.getClaimByStream(streamId);
      if (!claim) {
        // Auto-link: if there's an active claim for this agent+task, link it
        const claims = (await this.store.query(
          `SELECT id FROM task_claims WHERE agent_id = ? AND status = 'active' AND task_id = ?`,
          [agentId, taskId]
        )).rows;
        if (claims.length > 0) {
          await this.tasks.linkClaimToStream(claims[0].id, streamId);
        }
      }
    }

    await this.activity.log({
      agent_id: agentId,
      event_type: 'workspace_created',
      target_type: 'stream',
      target_id: streamId,
      metadata: { dependsOn, taskId },
    });

    return { streamId, path: worktree.path || worktreePath };
  }

  /** List all active workspaces. */
  async listWorkspaces() {
    const tracker = this._ensureTracker();
    const worktrees = tracker.listWorktrees();
    const result = [];

    for (const wt of worktrees) {
      const stream = wt.currentStream ? tracker.getStream(wt.currentStream) : null;
      const agent = await this.getAgent(wt.agentId);
      result.push({
        agentId: wt.agentId,
        agentName: agent?.name || wt.agentId,
        path: wt.path,
        streamId: wt.currentStream,
        streamName: stream?.name || null,
        streamStatus: stream?.status || null,
        lastActive: wt.lastActive,
      });
    }

    return result;
  }

  /** Destroy an agent's workspace (deallocate worktree, optionally abandon stream). */
  async destroyWorkspace(agentId, { abandonStream = false } = {}) {
    const tracker = this._ensureTracker();
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No workspace found for agent: ${agentId}`);

    if (abandonStream && worktree.currentStream) {
      tracker.abandonStream(worktree.currentStream, { reason: 'workspace_destroyed' });
    }

    tracker.deallocateWorktree(agentId);

    await this.activity.log({
      agent_id: agentId,
      event_type: 'workspace_destroyed',
      target_type: 'stream',
      target_id: worktree.currentStream,
    });

    return { success: true };
  }

  // ── Committing (git-cascade + mode policy) ─────────────────

  /**
   * Commit changes from an agent's worktree.
   *
   * In swarm mode: auto-merges to buffer after commit.
   * In review/gated mode: stays in the agent's stream.
   *
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {string} opts.message - Commit message
   * @param {string} [opts.streamId] - Override stream (defaults to agent's current stream)
   * @returns {{ commit: string, changeId: string, merged?: boolean }}
   */
  async commit(opts) {
    const { agentId, message, streamId: overrideStreamId } = opts;
    const tracker = this._ensureTracker();
    const repo = await this.repo();

    // Resolve stream and worktree
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No workspace found for agent: ${agentId}`);

    const streamId = overrideStreamId || worktree.currentStream;
    if (!streamId) throw new Error('No active stream for this workspace');

    // Commit via git-cascade (handles Change-Id tracking)
    const { commit, changeId } = tracker.commitChanges({
      streamId,
      agentId,
      worktree: worktree.path,
      message,
    });

    const result = { commit, changeId, merged: false };

    // Mode-specific post-commit behavior
    if (repo?.merge_mode === 'swarm') {
      // Auto-merge to buffer
      try {
        const bufferBranch = repo.buffer_branch || 'buffer';
        const mergeResult = tracker.mergeStream({
          streamId,
          targetBranch: bufferBranch,
          agentId,
          strategy: 'merge',
        });

        if (mergeResult.success) {
          result.merged = true;
          result.mergeCommit = mergeResult.mergeCommit;

          // Cascade rebase to keep other streams up to date
          const activeStreams = tracker.listStreams({ status: 'active' });
          for (const s of activeStreams) {
            if (s.id === streamId) continue;
            try {
              tracker.syncWithParent(s.id, s.agentId, s.id, 'abort');
            } catch {
              // Conflict — stream will be marked, agent resolves later
            }
          }
        } else if (mergeResult.conflicts) {
          result.conflicts = mergeResult.conflicts;
        }
      } catch (err) {
        result.mergeError = err.message;
      }
    }

    await this.activity.log({
      agent_id: agentId,
      event_type: 'commit',
      target_type: 'stream',
      target_id: streamId,
      metadata: { commit, changeId, merged: result.merged },
    });

    return result;
  }

  // ── Review lifecycle ───────────────────────────────────────

  /**
   * Submit a stream for review.
   *
   * Creates review blocks from the stream's commits and marks
   * it as in-review.
   */
  async submitForReview(streamId, agentId) {
    const tracker = this._ensureTracker();
    const stream = tracker.getStream(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    // Auto-populate review blocks from commits
    tracker.autoPopulateStack(streamId);

    // Update stream metadata to indicate review status
    tracker.updateStream(streamId, {
      metadata: { ...stream.metadata, review_status: 'in_review' },
    });

    await this.activity.log({
      agent_id: agentId,
      event_type: 'submit_for_review',
      target_type: 'stream',
      target_id: streamId,
    });

    return { streamId, reviewBlocks: tracker.getStack(streamId) };
  }

  /**
   * Submit a review verdict for a stream.
   */
  async submitReview(streamId, reviewerId, verdict, feedback = '', opts = {}) {
    const { reviewBlockId = null, isHuman = false } = opts;
    const repo = await this.repo();

    // Record in gitswarm's patch_reviews table
    const result = await this.store.query(
      `INSERT INTO patch_reviews (stream_id, review_block_id, reviewer_id, verdict, feedback, is_human)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
         verdict = ?, feedback = ?, review_block_id = ?, is_human = ?, reviewed_at = datetime('now')
       RETURNING *`,
      [streamId, reviewBlockId, reviewerId, verdict, feedback, isHuman ? 1 : 0,
       verdict, feedback, reviewBlockId, isHuman ? 1 : 0]
    );

    // If there's a review block, update its status in git-cascade
    if (reviewBlockId && verdict === 'approve') {
      try {
        this._ensureTracker().setReviewStatus({
          reviewBlockId,
          status: 'approved',
          reviewedBy: reviewerId,
        });
      } catch {
        // Review block may not exist in git-cascade
      }
    }

    await this.activity.log({
      agent_id: reviewerId,
      event_type: 'review_submitted',
      target_type: 'stream',
      target_id: streamId,
      metadata: { verdict, reviewBlockId },
    });

    return result.rows[0];
  }

  /**
   * Check consensus status for a stream.
   */
  async checkConsensus(streamId) {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');
    return this.permissions.checkConsensus(streamId, repo.id);
  }

  /**
   * Get review blocks for a stream.
   */
  getReviewBlocks(streamId) {
    return this._ensureTracker().getStack(streamId);
  }

  /**
   * Get all reviews for a stream.
   */
  async getReviews(streamId) {
    return (await this.store.query(
      `SELECT pr.*, a.name as reviewer_name FROM patch_reviews pr
       LEFT JOIN agents a ON pr.reviewer_id = a.id WHERE pr.stream_id = ?
       ORDER BY pr.reviewed_at`,
      [streamId]
    )).rows;
  }

  // ── Merging (mode-dependent) ────────────────────────────────

  /**
   * Merge a stream to the buffer branch.
   *
   * - swarm: direct merge (already done on commit, but can be called explicitly)
   * - review: checks consensus, then enqueues in merge queue
   * - gated: checks maintainer permission, then enqueues
   *
   * @param {string} streamId
   * @param {string} agentId - Agent requesting the merge
   * @returns {object} merge result
   */
  async mergeToBuffer(streamId, agentId) {
    const tracker = this._ensureTracker();
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    const bufferBranch = repo.buffer_branch || 'buffer';
    const mode = repo.merge_mode || 'review';

    // Permission check depends on mode
    if (mode === 'gated') {
      const { isMaintainer } = await this.permissions.isMaintainer(agentId, repo.id);
      if (!isMaintainer) {
        throw new Error('Gated mode: only maintainers can merge streams to buffer');
      }
    }

    if (mode === 'review' || mode === 'gated') {
      // Check consensus
      const consensus = await this.permissions.checkConsensus(streamId, repo.id);
      if (!consensus.reached) {
        throw new Error(`Consensus not reached: ${consensus.reason}`);
      }
    }

    // Compute merge priority from linked task
    let priority = 50; // default: medium
    const claim = await this.tasks.getClaimByStream(streamId);
    if (claim) {
      const priorityMap = { critical: 0, high: 25, medium: 50, low: 75 };
      priority = priorityMap[claim.priority] ?? 50;
    }

    // Add to merge queue and process
    const entryId = tracker.addToMergeQueue({
      streamId,
      targetBranch: bufferBranch,
      priority,
      agentId,
    });

    tracker.markMergeQueueReady(entryId);

    const queueResult = tracker.processMergeQueue({
      targetBranch: bufferBranch,
      worktree: this.repoPath,
      agentId,
    });

    // Update stage metrics after merge
    await this.stages.updateMetrics(repo.id, tracker);

    await this.activity.log({
      agent_id: agentId,
      event_type: 'stream_merged',
      target_type: 'stream',
      target_id: streamId,
      metadata: { bufferBranch, priority, queueResult },
    });

    return { streamId, entryId, queueResult };
  }

  // ── Stream inspection ──────────────────────────────────────

  /** List all active streams. */
  listActiveStreams() {
    return this._ensureTracker().listStreams({ status: 'active' });
  }

  /** Get diff between a stream and buffer. */
  getStreamDiff(streamId) {
    const tracker = this._ensureTracker();
    const stream = tracker.getStream(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    const branchName = tracker.getStreamBranchName(streamId);
    try {
      return _git(this.repoPath, `git diff buffer...${branchName} --stat`);
    } catch {
      return '';
    }
  }

  /** Get the full diff content for a stream. */
  getStreamDiffFull(streamId) {
    const tracker = this._ensureTracker();
    const branchName = tracker.getStreamBranchName(streamId);
    try {
      return _git(this.repoPath, `git diff buffer...${branchName}`);
    } catch {
      return '';
    }
  }

  /** Get stream details including changes. */
  getStreamInfo(streamId) {
    const tracker = this._ensureTracker();
    const stream = tracker.getStream(streamId);
    if (!stream) return null;

    const changes = tracker.getChangesForStream(streamId);
    const ops = tracker.getOperations({ streamId });
    const deps = tracker.getDependencies(streamId);
    const children = tracker.getChildStreams(streamId);

    return { stream, changes, operations: ops, dependencies: deps, children };
  }

  // ── Stabilization ──────────────────────────────────────────

  /**
   * Run stabilization against the buffer branch.
   *
   * 1. Run stabilize_command on the buffer
   * 2. On green: tag buffer HEAD, optionally promote to main
   * 3. On red: bisect to find breaking merge, optionally auto-revert
   *
   * @returns {object} stabilization result
   */
  async stabilize() {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');
    if (!repo.stabilize_command) throw new Error('No stabilize_command configured');

    const bufferBranch = repo.buffer_branch || 'buffer';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Run tests on buffer
    let testsPassed = false;
    let testOutput = '';
    try {
      testOutput = execSync(repo.stabilize_command, {
        cwd: this.repoPath,
        encoding: 'utf-8',
        env: { ...process.env, GIT_BRANCH: bufferBranch },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000, // 5 minute timeout
      });
      testsPassed = true;
    } catch (err) {
      testOutput = err.stdout || err.message;
    }

    if (testsPassed) {
      // Green: tag and optionally promote
      const tagName = `green/${timestamp}`;
      try {
        _git(this.repoPath, `git tag "${tagName}" "${bufferBranch}"`);
      } catch {
        // Tag creation may fail if buffer doesn't exist
      }

      let promoted = false;
      if (repo.auto_promote_on_green) {
        try {
          const result = await this.promote({ tag: tagName });
          promoted = result.success;
        } catch {
          // Promotion failed, not critical
        }
      }

      await this.activity.log({
        event_type: 'stabilize_green',
        target_type: 'repo',
        target_id: repo.id,
        metadata: { tag: tagName, promoted },
      });

      return { success: true, status: 'green', tag: tagName, promoted };
    }

    // Red: find breaking merge and optionally revert
    const result = { success: false, status: 'red', output: testOutput.slice(0, 2000) };

    if (repo.auto_revert_on_red) {
      try {
        const tracker = this._ensureTracker();
        // Find recent merge operations
        const ops = tracker.getOperations({}).filter(
          op => op.opType === 'merge'
        );

        if (ops.length > 0) {
          // Bisect: try reverting the most recent merge first
          const lastMerge = ops[ops.length - 1];
          tracker.rollbackToOperation({
            operationId: lastMerge.id,
            streamId: lastMerge.streamId,
            agentId: 'stabilizer',
            worktree: this.repoPath,
          });

          result.reverted = { streamId: lastMerge.streamId, operationId: lastMerge.id };

          // Create a critical task for the breaking agent
          const stream = tracker.getStream(lastMerge.streamId);
          if (stream) {
            await this.tasks.create(repo.id, {
              title: `Fix breaking merge from stream ${stream.name}`,
              description: `Stabilization detected test failure after merging stream ${stream.name}. The merge has been auto-reverted.`,
              priority: 'critical',
            }, null);
          }
        }
      } catch (err) {
        result.revertError = err.message;
      }
    }

    await this.activity.log({
      event_type: 'stabilize_red',
      target_type: 'repo',
      target_id: repo.id,
      metadata: { reverted: result.reverted },
    });

    return result;
  }

  // ── Promotion ──────────────────────────────────────────────

  /**
   * Promote buffer to main (or a specific green tag).
   *
   * @param {object} [opts]
   * @param {string} [opts.tag] - Specific tag to promote (default: buffer HEAD)
   * @returns {{ success: boolean, from: string, to: string }}
   */
  async promote(opts = {}) {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    const promoteTarget = repo.promote_target || 'main';
    const source = opts.tag || (repo.buffer_branch || 'buffer');

    try {
      // Fast-forward main to the source ref
      _git(this.repoPath, `git checkout "${promoteTarget}"`);
      _git(this.repoPath, `git merge --ff-only "${source}"`);

      // Return to buffer
      _git(this.repoPath, `git checkout "${repo.buffer_branch || 'buffer'}"`);

      await this.activity.log({
        event_type: 'promote',
        target_type: 'repo',
        target_id: repo.id,
        metadata: { source, target: promoteTarget },
      });

      return { success: true, from: source, to: promoteTarget };
    } catch (err) {
      // Restore state on failure
      try { _git(this.repoPath, `git checkout "${repo.buffer_branch || 'buffer'}"`); } catch {}
      throw new Error(`Promotion failed: ${err.message}`);
    }
  }

  // ── Legacy patch helpers (v1 compat, thin wrappers) ────────

  async createPatch(repoId, authorId, data) {
    const { title, description = '', source_branch, target_branch = 'main' } = data;
    const result = await this.store.query(
      `INSERT INTO patches (repo_id, author_id, title, description, source_branch, target_branch)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      [repoId, authorId, title, description, source_branch, target_branch]
    );
    return result.rows[0];
  }

  async listPatches(repoId, status = null) {
    let sql = `SELECT p.*, a.name as author_name FROM patches p
               LEFT JOIN agents a ON p.author_id = a.id WHERE p.repo_id = ?`;
    const params = [repoId];
    if (status) { sql += ` AND p.status = ?`; params.push(status); }
    sql += ` ORDER BY p.created_at DESC`;
    return (await this.store.query(sql, params)).rows;
  }

  close() {
    if (this.tracker) {
      try { this.tracker.close(); } catch {}
      this.tracker = null;
    }
    this.store.close();
  }

  // ── internal ──────────────────────────────────────────────

  static findSwarmDir(startPath) {
    let dir = startPath;
    while (dir !== '/') {
      const candidate = join(dir, GITSWARM_DIR);
      if (existsSync(join(candidate, DB_FILE)) || existsSync(join(candidate, CONFIG_FILE))) {
        return candidate;
      }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  _generateKey() {
    return 'gsw_' + randomBytes(24).toString('hex');
  }

  _hashKey(key) {
    return createHash('sha256').update(key).digest('hex');
  }
}

// ── git helpers ──────────────────────────────────────────────
// Minimal git CLI wrappers used only for operations not covered by git-cascade
// (e.g., promotion ff-merge, buffer branch creation, tagging).

function _git(cwd, cmd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function _gitSafe(cwd, cmd) {
  try { return _git(cwd, cmd); } catch { return null; }
}
