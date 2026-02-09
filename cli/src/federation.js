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
import { SyncClient } from './sync-client.js';

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

    // Mode B sync client — initialized via connectServer()
    this.sync = null;
  }

  /**
   * Connect to a remote web server for Mode B (server-coordinated) operation.
   * When connected, local operations are reported to the server and the server
   * becomes the authority for consensus and reviews.
   *
   * @param {object} opts
   * @param {string} opts.serverUrl - Base URL (e.g. http://localhost:3000/api/v1)
   * @param {string} opts.apiKey    - Agent API key
   * @param {string} opts.agentId   - Agent UUID
   */
  async connectServer({ serverUrl, apiKey, agentId }) {
    this.sync = new SyncClient({
      serverUrl,
      apiKey,
      agentId,
      store: this.store,
    });

    // Persist server config
    const cfg = this.config();
    cfg.server = { url: serverUrl, agentId };
    writeFileSync(join(this.swarmDir, CONFIG_FILE), JSON.stringify(cfg, null, 2));

    // Test connectivity and flush any queued events
    const online = await this.sync.ping();
    let flushed = 0;
    if (online) {
      try {
        const result = await this.sync.flushQueue();
        flushed = result.flushed;
      } catch {
        // Non-fatal: queue will be flushed on next connection
      }
    }
    return { connected: online, serverUrl, flushed };
  }

  /**
   * Restore server connection from saved config (if present).
   * Called during open() if server config exists.
   */
  _restoreSyncFromConfig(apiKey) {
    const cfg = this.config();
    if (cfg.server?.url && apiKey) {
      this.sync = new SyncClient({
        serverUrl: cfg.server.url,
        apiKey,
        agentId: cfg.server.agentId,
        store: this.store,
      });
    }
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
   * Find the stream ID for the buffer branch.
   * The buffer branch is tracked as a stream via trackExistingBranch during init.
   */
  _findBufferStreamId(bufferBranch = 'buffer') {
    const tracker = this._ensureTracker();
    const streams = tracker.listStreams({});
    for (const s of streams) {
      if (s.existingBranch === bufferBranch) return s.id;
      try {
        const branch = tracker.getStreamBranchName(s.id);
        if (branch === bufferBranch) return s.id;
      } catch { /* ignore */ }
    }
    return null;
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
        fed.tracker.createStream({
          name: `buffer:${bufferBranch}`,
          agentId: 'federation',
          existingBranch: bufferBranch,
          createBranch: false,
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

    // Mode B: report stream creation to server
    if (this.sync) {
      try {
        const branchName = tracker.getStreamBranchName(streamId);
        await this.sync.syncStreamCreated(repo.id, {
          streamId,
          name: streamName,
          branch: branchName,
          baseBranch: repo.buffer_branch || 'buffer',
          parentStreamId: dependsOn,
          taskId,
        });
      } catch {
        // Server unreachable — queue for later sync
        this.sync._queueEvent({ type: 'stream_created', data: {
          repoId: repo.id, streamId, name: streamName,
          branch: tracker.getStreamBranchName(streamId),
          baseBranch: repo.buffer_branch || 'buffer',
          parentStreamId: dependsOn,
        }});
      }
    }

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
      // Auto-merge to buffer (bypasses consensus)
      try {
        const bufferBranch = repo.buffer_branch || 'buffer';
        const streamBranch = tracker.getStreamBranchName(streamId);

        _git(this.repoPath, `git checkout "${bufferBranch}"`);
        _git(this.repoPath, `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`);
        result.merged = true;

        // Mark stream as merged in git-cascade
        tracker.updateStream(streamId, { status: 'merged' });
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

    // Mode B: report commit to server
    if (this.sync) {
      try {
        const repo2 = await this.repo();
        await this.sync.syncCommit(repo2.id, streamId, {
          commitHash: commit,
          changeId,
          message,
        });
      } catch {
        // Server unreachable — queue for later sync
        const repo2 = await this.repo();
        this.sync._queueEvent({ type: 'commit', data: {
          repoId: repo2.id, streamId, commitHash: commit, changeId, message,
        }});
      }
    }

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

    // Auto-populate review blocks from commits (if git-cascade supports it)
    try { tracker.autoPopulateStack(streamId); } catch {
      // Method may not be available in this git-cascade version
    }

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

    // Mode B: report review submission to server
    if (this.sync) {
      try {
        const repo = await this.repo();
        await this.sync.syncSubmitForReview(repo.id, streamId);
      } catch {
        const repo = await this.repo();
        this.sync._queueEvent({ type: 'submit_review', data: {
          repoId: repo.id, streamId,
        }});
      }
    }

    let reviewBlocks = [];
    try { reviewBlocks = tracker.getStack(streamId); } catch {
      // Method may not be available in this git-cascade version
    }
    return { streamId, reviewBlocks };
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

    // Mode B: report review to server
    if (this.sync) {
      try {
        const repo = await this.repo();
        await this.sync.syncReview(repo.id, streamId, {
          verdict, feedback, tested: opts.tested || false,
        });
      } catch {
        // Server unreachable — queued for later
        this.sync._queueEvent({ type: 'review', data: {
          repoId: (await this.repo()).id, streamId, verdict, feedback,
        }});
      }
    }

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
    try { return this._ensureTracker().getStack(streamId); } catch { return []; }
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
      // Check consensus — use server as authority when connected (Mode B)
      let consensus;
      if (this.sync) {
        try {
          consensus = await this.sync.checkConsensus(repo.id, streamId);
        } catch {
          // Server unreachable — fall back to local consensus
          consensus = await this.permissions.checkConsensus(streamId, repo.id);
        }
      } else {
        consensus = await this.permissions.checkConsensus(streamId, repo.id);
      }
      if (!consensus.reached) {
        throw new Error(`Consensus not reached: ${consensus.reason}`);
      }
    }

    // Merge stream branch into buffer via git
    const streamBranch = tracker.getStreamBranchName(streamId);

    _git(this.repoPath, `git checkout "${bufferBranch}"`);
    try {
      _git(this.repoPath, `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`);
    } catch (err) {
      // Abort merge on conflict and report
      _gitSafe(this.repoPath, 'git merge --abort');
      throw new Error(`Merge failed: ${err.message}`);
    }

    // Mark stream as merged in git-cascade
    tracker.updateStream(streamId, { status: 'merged' });
    const mergeResult = { success: true, newHead: _git(this.repoPath, 'git rev-parse HEAD') };

    // Update stage metrics after merge
    await this.stages.updateMetrics(repo.id, tracker);

    await this.activity.log({
      agent_id: agentId,
      event_type: 'stream_merged',
      target_type: 'stream',
      target_id: streamId,
      metadata: { bufferBranch, mergeResult },
    });

    // Mode B: report merge to server
    if (this.sync) {
      try {
        await this.sync.syncMergeCompleted(repo.id, streamId, {
          mergeCommit: mergeResult.newHead,
          targetBranch: bufferBranch,
        });
      } catch {
        this.sync._queueEvent({ type: 'merge', data: {
          repoId: repo.id, streamId,
          mergeCommit: mergeResult.newHead, targetBranch: bufferBranch,
        }});
      }
    }

    return { streamId, mergeResult };
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

      // Mode B: report green stabilization to server
      if (this.sync) {
        try {
          const bufferCommit = _gitSafe(this.repoPath, `git rev-parse "${bufferBranch}"`) || '';
          await this.sync.syncStabilization(repo.id, {
            result: 'green', tag: tagName, bufferCommit,
          });
        } catch {
          this.sync._queueEvent({ type: 'stabilize', data: {
            repoId: repo.id, result: 'green', tag: tagName,
          }});
        }
      }

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

    // Mode B: report red stabilization to server
    if (this.sync) {
      try {
        const bufferCommit = _gitSafe(this.repoPath, `git rev-parse "${bufferBranch}"`) || '';
        await this.sync.syncStabilization(repo.id, {
          result: 'red', bufferCommit,
          breakingStreamId: result.reverted?.streamId,
        });
      } catch {
        this.sync._queueEvent({ type: 'stabilize', data: {
          repoId: repo.id, result: 'red',
          breakingStreamId: result.reverted?.streamId,
        }});
      }
    }

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

      // Mode B: report promotion to server
      if (this.sync) {
        try {
          const fromCommit = _gitSafe(this.repoPath, `git rev-parse "${source}"`) || '';
          const toCommit = _gitSafe(this.repoPath, `git rev-parse "${promoteTarget}"`) || '';
          await this.sync.syncPromotion(repo.id, {
            fromCommit, toCommit, triggeredBy: opts.tag ? 'auto' : 'manual',
          });
        } catch {
          this.sync._queueEvent({ type: 'promote', data: {
            repoId: repo.id, triggeredBy: opts.tag ? 'auto' : 'manual',
          }});
        }
      }

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
