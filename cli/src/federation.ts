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
import { generateId } from './shared/ids.js';
import { BUILTIN_PLUGINS } from './plugins/builtins.js';
import { CliSafeOutputs } from './plugins/safe-outputs.js';
import { MergeLock } from './merge-lock.js';
import { readConfigYml, extractRepoFields, readPluginsYml, parsePlugins } from './config-reader.js';
import type { ParsedPlugin } from './config-reader.js';

const GITSWARM_DIR = '.gitswarm';
const DB_FILE = 'federation.db';
const CONFIG_FILE = 'config.json';
const WORKTREE_DIR = '.worktrees';

export interface ConnectServerOptions {
  serverUrl: string;
  apiKey: string;
  agentId: string;
}

export interface ConnectServerResult {
  connected: boolean;
  serverUrl: string;
  flushed: number;
}

export interface CreateWorkspaceOptions {
  agentId: string;
  taskId?: string;
  dependsOn?: string;
  name?: string;
}

export interface CreateWorkspaceResult {
  streamId: string;
  path: string;
}

export interface WorkspaceInfo {
  agentId: string;
  agentName: string;
  path: string;
  streamId: string | null;
  streamName: string | null;
  streamStatus: string | null;
  lastActive: string | null;
}

export interface CommitOptions {
  agentId: string;
  message: string;
  streamId?: string;
}

export interface CommitResult {
  commit: string;
  changeId: string;
  merged: boolean;
  mergeError?: string;
  conflicts?: unknown[];
}

export interface ReviewSubmitResult {
  streamId: string;
  reviewBlocks: Record<string, unknown>[];
}

export interface ReviewSubmitOptions {
  reviewBlockId?: string | null;
  isHuman?: boolean;
  tested?: boolean;
}

export interface MergeResult {
  streamId: string;
  mergeResult: { success: boolean; newHead: string };
}

export interface StabilizeResult {
  success: boolean;
  status: string;
  tag?: string;
  promoted?: boolean;
  output?: string;
  reverted?: { streamId: string; operationId: string };
  revertError?: string;
}

export interface PromoteOptions {
  tag?: string;
}

export interface PromoteResult {
  success: boolean;
  from: string;
  to: string;
}

export interface InitOptions {
  name?: string;
  merge_mode?: string;
  ownership_model?: string;
  agent_access?: string;
  consensus_threshold?: number;
  min_reviews?: number;
  buffer_branch?: string;
  promote_target?: string;
  stabilize_command?: string | null;
}

export interface InitResult {
  federation: Federation;
  config: Record<string, unknown>;
}

export interface PullConfigResult {
  updated: string[];
  config: Record<string, unknown>;
}

export interface StreamInfo {
  stream: Record<string, unknown>;
  changes: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
  children: Record<string, unknown>[];
}

export class Federation {
  repoPath: string;
  swarmDir: string;
  store: SqliteStore;
  permissions: PermissionService;
  tasks: TaskService;
  council: CouncilService;
  stages: StageService;
  activity: ActivityService;
  safeOutputs: CliSafeOutputs;
  mergeLock: MergeLock;
  _pluginsCache: ParsedPlugin[] | null;
  tracker: InstanceType<typeof MultiAgentRepoTracker> | null;
  sync: SyncClient | null;

  constructor(repoPath: string, store: SqliteStore) {
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

    // Safe outputs enforcer for plugin budget/rate limiting
    this.safeOutputs = new CliSafeOutputs(store);

    // Merge lock to prevent concurrent buffer merges
    this.mergeLock = new MergeLock(join(repoPath, GITSWARM_DIR));

    // Cached plugins from .gitswarm/plugins.yml
    this._pluginsCache = null;

    // git-cascade tracker — initialized lazily via _ensureTracker()
    this.tracker = null;

    // Mode B sync client — initialized via connectServer()
    this.sync = null;
  }

  /**
   * Connect to a remote web server for Mode B (server-coordinated) operation.
   * When connected, local operations are reported to the server and the server
   * becomes the authority for consensus and reviews.
   */
  async connectServer({ serverUrl, apiKey, agentId }: ConnectServerOptions): Promise<ConnectServerResult> {
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
      // Mark repo as server-authoritative for consensus (split-brain prevention)
      const repo = await this.repo();
      if (repo && repo.consensus_authority !== 'server') {
        await this.store.query(
          `UPDATE repos SET consensus_authority = 'server' WHERE id = ?`,
          [repo.id]
        );
      }

      // Register repo with server if not already registered
      if (repo && !repo.org_id) {
        try {
          const result = await this.sync.registerRepo({
            name: repo.name as string,
            description: repo.description as string,
            ownershipModel: repo.ownership_model as string,
            mergeMode: repo.merge_mode as string,
            consensusThreshold: repo.consensus_threshold as number,
            minReviews: repo.min_reviews as number,
            bufferBranch: repo.buffer_branch as string,
            promoteTarget: repo.promote_target as string,
          });
          if ((result as any)?.org_id) {
            await this.store.query(
              `UPDATE repos SET org_id = ? WHERE id = ?`,
              [(result as any).org_id, repo.id]
            );
          }
        } catch {
          // Non-fatal: repo registration can be retried
        }
      }

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
  _restoreSyncFromConfig(apiKey: string): void {
    const cfg = this.config();
    if ((cfg.server as any)?.url && apiKey) {
      this.sync = new SyncClient({
        serverUrl: (cfg.server as any).url,
        apiKey,
        agentId: (cfg.server as any).agentId,
        store: this.store,
      });
    }
  }

  /**
   * Initialize the git-cascade tracker.
   * Shares the same SQLite database instance with gc_ table prefix.
   */
  _ensureTracker(): InstanceType<typeof MultiAgentRepoTracker> {
    if (this.tracker) return this.tracker;
    this.tracker = new MultiAgentRepoTracker({
      repoPath: this.repoPath,
      db: this.store.db,
      tablePrefix: 'gc_',
      skipRecovery: false,
    } as any);
    return this.tracker;
  }

  /**
   * Find the stream ID for the buffer branch.
   * The buffer branch is tracked as a stream via trackExistingBranch during init.
   */
  _findBufferStreamId(bufferBranch: string = 'buffer'): string | null {
    const tracker = this._ensureTracker();
    const streams = tracker.listStreams({});
    for (const s of streams) {
      if (s.existingBranch === bufferBranch) return s.id as string;
      try {
        const branch = tracker.getStreamBranchName(s.id as string);
        if (branch === bufferBranch) return s.id as string;
      } catch { /* ignore */ }
    }
    return null;
  }

  /**
   * Open an existing federation at the given repo path.
   * Looks for `.gitswarm/federation.db` up the directory tree.
   */
  static open(startPath: string = process.cwd()): Federation {
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

    // Apply .gitswarm/config.yml if present (repo-level config takes precedence)
    fed._applyRepoConfig();

    // Warn about plugins that require a server connection
    const pluginWarnings = fed.checkPluginCompatibility();
    for (const w of pluginWarnings) {
      console.error(`[gitswarm] warning: ${w}`);
    }

    return fed;
  }

  /**
   * Initialize a new federation in the given repo path.
   */
  static init(repoPath: string, options: InitOptions = {}): InitResult {
    const swarmDir = join(repoPath, GITSWARM_DIR);

    if (existsSync(join(swarmDir, DB_FILE))) {
      throw new Error('Federation already initialised in this repository.');
    }

    const dbPath = join(swarmDir, DB_FILE);
    const store = new SqliteStore(dbPath);
    store.migrate();

    const mergeMode = options.merge_mode || 'review';

    // Write default config
    const config: Record<string, unknown> = {
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
        fed.tracker!.createStream({
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
  config(): Record<string, unknown> {
    const p = join(this.swarmDir, CONFIG_FILE);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  /** Write updated values back to `.gitswarm/config.json`. */
  _saveConfig(updates: Record<string, unknown>): Record<string, unknown> {
    const p = join(this.swarmDir, CONFIG_FILE);
    const current = this.config();
    const merged = { ...current, ...updates, _lastSync: new Date().toISOString() };
    writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
    return merged;
  }

  /**
   * Pull config from server and reconcile with local config.json + repos table.
   * Only updates server-owned fields and fields where remote is newer.
   * Returns { updated: [...fields], config } or null if no sync client.
   */
  async pullConfig(): Promise<PullConfigResult | null> {
    if (!this.sync) return null;

    const repo = await this.repo();
    if (!repo) return null;

    const remote = await this.sync.getRepoConfig(repo.id as string) as any;
    if (!remote || !remote.config) return null;

    // Fields the server owns — always take from server
    const serverOwnedFields: string[] = [
      'merge_mode', 'ownership_model', 'consensus_threshold', 'min_reviews',
      'human_review_weight', 'buffer_branch', 'promote_target',
      'auto_promote_on_green', 'auto_revert_on_red', 'stabilize_command',
      'agent_access', 'min_karma', 'plugins_enabled', 'stage',
    ];

    const localConfig = this.config();
    const updates: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    for (const field of serverOwnedFields) {
      if ((remote.config as Record<string, unknown>)[field] !== undefined &&
          (remote.config as Record<string, unknown>)[field] !== localConfig[field]) {
        updates[field] = (remote.config as Record<string, unknown>)[field];
        updatedFields.push(field);
      }
    }

    if (updatedFields.length > 0) {
      // Update config.json
      this._saveConfig(updates);

      // Update local repos table to match
      const repoUpdateFields: string[] = [
        'merge_mode', 'ownership_model', 'consensus_threshold', 'min_reviews',
        'human_review_weight', 'buffer_branch', 'promote_target',
        'auto_promote_on_green', 'auto_revert_on_red', 'stabilize_command',
      ];
      for (const field of repoUpdateFields) {
        if (updates[field] !== undefined) {
          await this.store.query(
            `UPDATE repos SET ${field} = ? WHERE id = ?`,
            [updates[field], repo.id]
          );
        }
      }
    }

    return { updated: updatedFields, config: { ...localConfig, ...updates } };
  }

  /**
   * Apply .gitswarm/config.yml to the local repos table.
   * Repo-owned fields from the YAML take precedence over config.json values.
   * Called once during open() — idempotent.
   */
  _applyRepoConfig(): void {
    const yamlConfig = readConfigYml(this.repoPath);
    if (!yamlConfig) return; // No config.yml — nothing to apply

    const fields = extractRepoFields(yamlConfig);
    if (Object.keys(fields).length === 0) return;

    // Get repo synchronously (open() is sync, so use db.prepare directly)
    const repo = this.store.db.prepare('SELECT id FROM repos LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!repo) return;

    // Build SET clause for each field
    for (const [key, value] of Object.entries(fields)) {
      try {
        this.store.db.prepare(`UPDATE repos SET ${key} = ? WHERE id = ?`).run(value, repo.id);
      } catch {
        // Column may not exist in older schema versions — skip silently
      }
    }
  }

  /**
   * Load plugins from .gitswarm/plugins.yml.
   * Returns parsed plugin definitions or empty array if no file exists.
   */
  loadPlugins(): ParsedPlugin[] {
    if (this._pluginsCache) return this._pluginsCache;

    const pluginsConfig = readPluginsYml(this.repoPath);
    this._pluginsCache = pluginsConfig ? parsePlugins(pluginsConfig) : [];
    return this._pluginsCache;
  }

  /** Get the single repo record (local federations have one repo). */
  async repo(): Promise<Record<string, unknown> | null> {
    const r = await this.store.query(`SELECT * FROM repos LIMIT 1`);
    return r.rows[0] || null;
  }

  // ── Agent helpers ──────────────────────────────────────────

  async registerAgent(name: string, description: string = ''): Promise<{ agent: Record<string, unknown>; api_key: string }> {
    const apiKey = this._generateKey();
    const hash = this._hashKey(apiKey);
    const result = await this.store.query(
      `INSERT INTO agents (name, description, api_key_hash) VALUES (?, ?, ?) RETURNING *`,
      [name, description, hash]
    );
    return { agent: result.rows[0], api_key: apiKey };
  }

  async listAgents(): Promise<Record<string, unknown>[]> {
    return (await this.store.query(
      `SELECT id, name, description, karma, status, created_at FROM agents ORDER BY created_at`
    )).rows;
  }

  async getAgent(idOrName: string): Promise<Record<string, unknown> | null> {
    const r = await this.store.query(
      `SELECT * FROM agents WHERE id = ? OR name = ?`, [idOrName, idOrName]
    );
    return r.rows[0] || null;
  }

  async resolveAgent(idOrName: string): Promise<Record<string, unknown>> {
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
   */
  async createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult> {
    const { agentId, taskId, dependsOn, name } = opts;
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    // Check permissions
    const { allowed } = await this.permissions.canPerform(agentId, repo.id as string, 'write');
    if (!allowed) throw new Error('Insufficient permissions to create workspace');

    const tracker = this._ensureTracker();

    let streamId: string;
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
          await this.tasks.linkClaimToStream(claims[0].id as string, streamId);
        }
      }
    }

    // Dual-write: record stream in policy-level streams table.
    // This is critical for consensus checks and stage metrics — log errors rather than swallowing.
    const branchForStream = tracker.getStreamBranchName(streamId);
    try {
      await this.store.query(
        `INSERT OR IGNORE INTO streams (id, repo_id, agent_id, name, branch, base_branch, parent_stream_id, task_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cli')`,
        [streamId, repo.id, agentId, streamName, branchForStream,
         repo.buffer_branch || 'buffer', dependsOn || null, taskId || null]
      );
    } catch (err: unknown) {
      console.error(`Warning: failed to write stream to policy table: ${(err as Error).message}`);
      console.error('Consensus checks and stage metrics may be incomplete.');
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
        const syncBranchName = tracker.getStreamBranchName(streamId);
        await this.sync.syncStreamCreated(repo.id as string, {
          streamId,
          name: streamName,
          branch: syncBranchName,
          baseBranch: (repo.buffer_branch as string) || 'buffer',
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

    return { streamId, path: (worktree!.path as string) || worktreePath };
  }

  /** List all active workspaces. */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const tracker = this._ensureTracker();
    const worktrees = tracker.listWorktrees();
    const result: WorkspaceInfo[] = [];

    for (const wt of worktrees) {
      const stream = wt.currentStream ? tracker.getStream(wt.currentStream as string) : null;
      const agent = await this.getAgent(wt.agentId as string);
      result.push({
        agentId: wt.agentId as string,
        agentName: (agent?.name as string) || (wt.agentId as string),
        path: wt.path as string,
        streamId: (wt.currentStream as string) || null,
        streamName: (stream?.name as string) || null,
        streamStatus: (stream?.status as string) || null,
        lastActive: (wt.lastActive as string) || null,
      });
    }

    return result;
  }

  /** Destroy an agent's workspace (deallocate worktree, optionally abandon stream). */
  async destroyWorkspace(agentId: string, { abandonStream = false }: { abandonStream?: boolean } = {}): Promise<{ success: boolean }> {
    const tracker = this._ensureTracker();
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No workspace found for agent: ${agentId}`);

    if (abandonStream && worktree.currentStream) {
      tracker.abandonStream(worktree.currentStream as string, { reason: 'workspace_destroyed' });
    }

    tracker.deallocateWorktree(agentId);

    await this.activity.log({
      agent_id: agentId,
      event_type: 'workspace_destroyed',
      target_type: 'stream',
      target_id: worktree.currentStream as string,
    });

    return { success: true };
  }

  // ── Committing (git-cascade + mode policy) ─────────────────

  /**
   * Commit changes from an agent's worktree.
   *
   * In swarm mode: auto-merges to buffer after commit.
   * In review/gated mode: stays in the agent's stream.
   */
  async commit(opts: CommitOptions): Promise<CommitResult> {
    const { agentId, message, streamId: overrideStreamId } = opts;
    const tracker = this._ensureTracker();
    const repo = await this.repo();

    // Resolve stream and worktree
    const worktree = tracker.getWorktree(agentId);
    if (!worktree) throw new Error(`No workspace found for agent: ${agentId}`);

    const streamId = overrideStreamId || worktree.currentStream as string;
    if (!streamId) throw new Error('No active stream for this workspace');

    // BUG-7 fix: Prevent commits to non-active streams
    try {
      const streamRow = await this.store.query(
        `SELECT status FROM streams WHERE id = ?`, [streamId]
      );
      if (streamRow.rows.length > 0 && streamRow.rows[0].status !== 'active') {
        throw new Error(`Cannot commit to stream with status '${streamRow.rows[0].status}'. Stream must be active.`);
      }
    } catch (err: unknown) {
      if ((err as Error).message.includes('Cannot commit to stream')) throw err;
      // streams table may not exist in older schema — allow commit to proceed
    }

    // Commit via git-cascade (handles Change-Id tracking)
    const { commit, changeId } = tracker.commitChanges({
      streamId,
      agentId,
      worktree: worktree.path,
      message,
    });

    const result: CommitResult = { commit, changeId, merged: false };

    // Mode-specific post-commit behavior
    if (repo?.merge_mode === 'swarm') {
      // Auto-merge to buffer (bypasses consensus)
      const lockResult = this.mergeLock.acquire(agentId);
      if (!lockResult.acquired) {
        result.mergeError = lockResult.reason;
      } else {
        try {
          const bufferBranch = (repo.buffer_branch as string) || 'buffer';
          const streamBranch = tracker.getStreamBranchName(streamId);

          _git(this.repoPath, `git checkout "${bufferBranch}"`);
          _git(this.repoPath, `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`);
          result.merged = true;

          // Mark stream as merged in git-cascade
          tracker.updateStream(streamId, { status: 'merged' });
        } catch (err: unknown) {
          result.mergeError = (err as Error).message;
        } finally {
          this.mergeLock.release();
        }
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
        await this.sync.syncCommit(repo!.id as string, streamId, {
          commitHash: commit,
          changeId,
          message,
        });
      } catch {
        // Server unreachable — queue for later sync
        this.sync._queueEvent({ type: 'commit', data: {
          repoId: repo!.id, streamId, commitHash: commit, changeId, message,
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
  async submitForReview(streamId: string, agentId: string): Promise<ReviewSubmitResult> {
    const tracker = this._ensureTracker();
    const stream = tracker.getStream(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    // Auto-populate review blocks from commits (if git-cascade supports it)
    try { tracker.autoPopulateStack(streamId); } catch {
      // Method may not be available in this git-cascade version
    }

    // Update stream metadata to indicate review status
    tracker.updateStream(streamId, {
      metadata: { ...(stream.metadata as Record<string, unknown>), review_status: 'in_review' },
    });

    // Update policy-level streams table
    try {
      await this.store.query(
        `UPDATE streams SET status = 'in_review', review_status = 'in_review', updated_at = datetime('now') WHERE id = ?`,
        [streamId]
      );
    } catch (err: unknown) {
      console.error(`Warning: failed to update stream in policy table: ${(err as Error).message}`);
    }

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
        await this.sync.syncSubmitForReview(repo!.id as string, streamId);
      } catch {
        const repo = await this.repo();
        this.sync._queueEvent({ type: 'submit_review', data: {
          repoId: repo!.id, streamId,
        }});
      }
    }

    let reviewBlocks: Record<string, unknown>[] = [];
    try { reviewBlocks = tracker.getStack(streamId); } catch {
      // Method may not be available in this git-cascade version
    }
    return { streamId, reviewBlocks };
  }

  /**
   * Submit a review verdict for a stream.
   */
  async submitReview(
    streamId: string,
    reviewerId: string,
    verdict: string,
    feedback: string = '',
    opts: ReviewSubmitOptions = {}
  ): Promise<Record<string, unknown>> {
    const { reviewBlockId = null, isHuman = false } = opts;

    // Normalize verdict: 'reject' is not a valid stored value — map to 'request_changes'
    if (verdict === 'reject') verdict = 'request_changes';

    const validVerdicts = ['approve', 'request_changes', 'comment'];
    if (!validVerdicts.includes(verdict)) {
      throw new Error(`Invalid verdict "${verdict}". Must be one of: ${validVerdicts.join(', ')}`);
    }

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
        await this.sync.syncReview(repo!.id as string, streamId, {
          verdict, feedback, tested: opts.tested || false,
        });
      } catch {
        // Server unreachable — queued for later
        this.sync._queueEvent({ type: 'review', data: {
          repoId: (await this.repo())!.id, streamId, verdict, feedback,
        }});
      }
    }

    return result.rows[0];
  }

  /**
   * Check consensus status for a stream.
   */
  async checkConsensus(streamId: string): Promise<Record<string, unknown>> {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');
    return this.permissions.checkConsensus(streamId, repo.id as string) as unknown as Record<string, unknown>;
  }

  /**
   * Get review blocks for a stream.
   */
  getReviewBlocks(streamId: string): Record<string, unknown>[] {
    try { return this._ensureTracker().getStack(streamId); } catch { return []; }
  }

  /**
   * Get all reviews for a stream.
   */
  async getReviews(streamId: string): Promise<Record<string, unknown>[]> {
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
   */
  async mergeToBuffer(streamId: string, agentId: string): Promise<MergeResult> {
    const tracker = this._ensureTracker();
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    const bufferBranch = (repo.buffer_branch as string) || 'buffer';
    const mode = (repo.merge_mode as string) || 'review';

    // BUG-17 fix: Enforce parent stream merge order
    try {
      const parentCheck = await this.store.query(
        `SELECT s2.status as parent_status FROM streams s
         JOIN streams s2 ON s.parent_stream_id = s2.id
         WHERE s.id = ?`,
        [streamId]
      );
      if (parentCheck.rows.length > 0 && parentCheck.rows[0].parent_status !== 'merged') {
        throw new Error('Parent stream must be merged first');
      }
    } catch (err: unknown) {
      if ((err as Error).message.includes('Parent stream must be merged')) throw err;
      // parent_stream_id column may not exist in older schemas — skip check
    }

    // Permission check depends on mode
    if (mode === 'gated') {
      if (this.sync) {
        // Mode B: delegate the full gated check to the server, which can
        // enforce maintainer status, human approval, and any additional
        // gating policies configured on the repo.
        try {
          const approval = await this.sync.requestMerge(repo.id as string, streamId) as any;
          if (!approval.approved) {
            throw new Error(
              `Gated mode: server denied merge — ${approval.consensus?.reason || 'maintainer approval required'}`
            );
          }
          // Server approved — skip the local consensus check below since
          // requestMerge already validated both gated permissions and consensus.
        } catch (err: unknown) {
          if ((err as Error).message?.includes('server denied merge')) throw err;
          // Server unreachable — queue instead of allowing local bypass
          this.sync._queueEvent({ type: 'merge_requested', data: {
            repoId: repo.id, streamId,
          }});
          throw new Error(
            'Gated mode: server unavailable for approval. Merge queued for when connectivity returns.'
          );
        }
      } else {
        // Mode A: fall back to local maintainer check (no human-in-the-loop available)
        const { isMaintainer } = await this.permissions.isMaintainer(agentId, repo.id as string);
        if (!isMaintainer) {
          throw new Error('Gated mode: only maintainers can merge streams to buffer');
        }
      }
    }

    if (mode === 'review' || (mode === 'gated' && !this.sync)) {
      // Check consensus — use server as authority when connected (Mode B).
      // In gated mode with sync, requestMerge above already checked consensus.
      let consensus: Record<string, unknown>;
      if (repo.consensus_authority === 'server' && this.sync) {
        // Flush any pending review events so the server has the latest data.
        // Block the merge if review-critical events failed to sync — the
        // server would evaluate consensus against incomplete data.
        const REVIEW_CRITICAL_TYPES = ['review', 'submit_review'];
        let flushResult: Record<string, unknown> | null;
        try {
          flushResult = await this.sync.flushQueue() as unknown as Record<string, unknown>;
        } catch {
          // Server unreachable — handled by the consensus check below
          flushResult = null;
        }

        if ((flushResult?.failedTypes as string[] | undefined)?.some((t: string) => REVIEW_CRITICAL_TYPES.includes(t))) {
          throw new Error(
            `Cannot check consensus: review event(s) failed to sync to server ` +
            `(${(flushResult!.failedTypes as string[]).filter((t: string) => REVIEW_CRITICAL_TYPES.includes(t)).join(', ')}). ` +
            `Retry with \`gitswarm merge\` when connectivity is restored.`
          );
        }

        try {
          consensus = await this.sync.checkConsensus(repo.id as string, streamId) as Record<string, unknown>;
        } catch {
          // Server unreachable — don't fall back to local consensus.
          // Queue the merge request instead of risking split-brain.
          this.sync._queueEvent({ type: 'merge_requested', data: {
            repoId: repo.id, streamId,
          }});
          throw new Error(
            'Server unavailable for consensus check. Merge queued for when connectivity returns.'
          );
        }
      } else {
        // Mode A (local-only) or not yet connected to server
        consensus = await this.permissions.checkConsensus(streamId, repo.id as string) as unknown as Record<string, unknown>;
      }
      if (!consensus.reached) {
        throw new Error(`Consensus not reached: ${consensus.reason}`);
      }
    }

    // Acquire merge lock to prevent concurrent buffer merges
    const lockResult = this.mergeLock.acquire(agentId);
    if (!lockResult.acquired) {
      throw new Error(lockResult.reason);
    }

    try {
      // Merge stream branch into buffer via git
      const streamBranch = tracker.getStreamBranchName(streamId);

      _git(this.repoPath, `git checkout "${bufferBranch}"`);
      try {
        _git(this.repoPath, `git merge "${streamBranch}" --no-ff -m "Merge ${streamBranch} into ${bufferBranch}"`);
      } catch (err: unknown) {
        // Abort merge on conflict and report
        _gitSafe(this.repoPath, 'git merge --abort');
        throw new Error(`Merge failed: ${(err as Error).message}`);
      }

      // Mark stream as merged in git-cascade and policy table
      tracker.updateStream(streamId, { status: 'merged' });
      try {
        await this.store.query(
          `UPDATE streams SET status = 'merged', review_status = 'approved', updated_at = datetime('now') WHERE id = ?`,
          [streamId]
        );
      } catch (err: unknown) {
        console.error(`Warning: failed to update stream status in policy table: ${(err as Error).message}`);
      }
      const mergeResultData = { success: true, newHead: _git(this.repoPath, 'git rev-parse HEAD') };

      // Update stage metrics after merge
      await this.stages.updateMetrics(repo.id as string, tracker as any);

      await this.activity.log({
        agent_id: agentId,
        event_type: 'stream_merged',
        target_type: 'stream',
        target_id: streamId,
        metadata: { bufferBranch, mergeResult: mergeResultData },
      });

      // Mode B: report merge to server
      if (this.sync) {
        try {
          await this.sync.syncMergeCompleted(repo.id as string, streamId, {
            mergeCommit: mergeResultData.newHead,
            targetBranch: bufferBranch,
          });
        } catch {
          this.sync._queueEvent({ type: 'merge', data: {
            repoId: repo.id, streamId,
            mergeCommit: mergeResultData.newHead, targetBranch: bufferBranch,
          }});
        }
      }

      return { streamId, mergeResult: mergeResultData };
    } finally {
      // Always release the lock, even on failure
      this.mergeLock.release();
    }
  }

  // ── Stream inspection ──────────────────────────────────────

  /** List all active streams. */
  listActiveStreams(): Record<string, unknown>[] {
    return this._ensureTracker().listStreams({ status: 'active' });
  }

  /** Get diff between a stream and buffer. */
  getStreamDiff(streamId: string): string {
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
  getStreamDiffFull(streamId: string): string {
    const tracker = this._ensureTracker();
    const branchName = tracker.getStreamBranchName(streamId);
    try {
      return _git(this.repoPath, `git diff buffer...${branchName}`);
    } catch {
      return '';
    }
  }

  /** Get stream details including changes. */
  getStreamInfo(streamId: string): StreamInfo | null {
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
   */
  async stabilize(): Promise<StabilizeResult> {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');
    if (!repo.stabilize_command) throw new Error('No stabilize_command configured');

    const bufferBranch = (repo.buffer_branch as string) || 'buffer';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Run tests on buffer
    let testsPassed = false;
    let testOutput = '';
    try {
      testOutput = execSync(repo.stabilize_command as string, {
        cwd: this.repoPath,
        encoding: 'utf-8',
        env: { ...process.env, GIT_BRANCH: bufferBranch },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000, // 5 minute timeout
      });
      testsPassed = true;
    } catch (err: unknown) {
      testOutput = (err as { stdout?: string; message: string }).stdout || (err as Error).message;
    }

    if (testsPassed) {
      // Green: tag and optionally promote
      const tagName = `green/${timestamp}`;
      try {
        _git(this.repoPath, `git tag "${tagName}" "${bufferBranch}"`);
      } catch {
        // Tag creation may fail if buffer doesn't exist
      }

      // Fire builtin plugins for stabilization_passed.
      // The promote_buffer_to_main plugin handles auto-promotion if configured.
      let promoted = false;
      try {
        await this._fireBuiltinPlugins('stabilization_passed', repo, {
          tag: tagName, bufferBranch, passed: true,
        });
        promoted = !!repo.auto_promote_on_green;
      } catch {
        // Plugin execution failed — fall back to direct promotion
        if (repo.auto_promote_on_green) {
          try {
            const result = await this.promote({ tag: tagName });
            promoted = result.success;
          } catch {
            // Promotion failed, not critical
          }
        }
      }

      await this.activity.log({
        event_type: 'stabilize_green',
        target_type: 'repo',
        target_id: repo.id as string,
        metadata: { tag: tagName, promoted },
      });

      // Mode B: report green stabilization to server
      if (this.sync) {
        try {
          const bufferCommit = _gitSafe(this.repoPath, `git rev-parse "${bufferBranch}"`) || '';
          await this.sync.syncStabilization(repo.id as string, {
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
    const result: StabilizeResult = { success: false, status: 'red', output: testOutput.slice(0, 2000) };

    // Fire builtin plugins for stabilization_failed
    try {
      await this._fireBuiltinPlugins('stabilization_failed', repo, {
        bufferBranch, passed: false, output: testOutput.slice(0, 500),
      });
    } catch { /* plugin execution non-fatal */ }

    if (repo.auto_revert_on_red) {
      try {
        const tracker = this._ensureTracker();
        // Find recent merge operations
        const ops = tracker.getOperations({}).filter(
          (op: Record<string, unknown>) => op.opType === 'merge'
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

          result.reverted = { streamId: lastMerge.streamId as string, operationId: lastMerge.id as string };

          // Create a critical task for the breaking agent
          const stream = tracker.getStream(lastMerge.streamId as string);
          if (stream) {
            await this.tasks.create(repo.id as string, {
              title: `Fix breaking merge from stream ${stream.name}`,
              description: `Stabilization detected test failure after merging stream ${stream.name}. The merge has been auto-reverted.`,
              priority: 'critical',
            }, null);
          }
        }
      } catch (err: unknown) {
        result.revertError = (err as Error).message;
      }
    }

    await this.activity.log({
      event_type: 'stabilize_red',
      target_type: 'repo',
      target_id: repo.id as string,
      metadata: { reverted: result.reverted },
    });

    // Mode B: report red stabilization to server
    if (this.sync) {
      try {
        const bufferCommit = _gitSafe(this.repoPath, `git rev-parse "${bufferBranch}"`) || '';
        await this.sync.syncStabilization(repo.id as string, {
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
   */
  async promote(opts: PromoteOptions = {}): Promise<PromoteResult> {
    const repo = await this.repo();
    if (!repo) throw new Error('No repository configured');

    const promoteTarget = (repo.promote_target as string) || 'main';
    const source = opts.tag || (repo.buffer_branch as string) || 'buffer';

    try {
      // Fast-forward main to the source ref
      _git(this.repoPath, `git checkout "${promoteTarget}"`);
      _git(this.repoPath, `git merge --ff-only "${source}"`);

      // Return to buffer
      _git(this.repoPath, `git checkout "${(repo.buffer_branch as string) || 'buffer'}"`);

      await this.activity.log({
        event_type: 'promote',
        target_type: 'repo',
        target_id: repo.id as string,
        metadata: { source, target: promoteTarget },
      });

      // Mode B: report promotion to server
      if (this.sync) {
        try {
          const fromCommit = _gitSafe(this.repoPath, `git rev-parse "${source}"`) || '';
          const toCommit = _gitSafe(this.repoPath, `git rev-parse "${promoteTarget}"`) || '';
          await this.sync.syncPromotion(repo.id as string, {
            fromCommit, toCommit, triggeredBy: opts.tag ? 'auto' : 'manual',
          });
        } catch {
          this.sync._queueEvent({ type: 'promote', data: {
            repoId: repo.id, triggeredBy: opts.tag ? 'auto' : 'manual',
          }});
        }
      }

      return { success: true, from: source, to: promoteTarget };
    } catch (err: unknown) {
      // Restore state on failure
      try { _git(this.repoPath, `git checkout "${(repo.buffer_branch as string) || 'buffer'}"`); } catch {}
      throw new Error(`Promotion failed: ${(err as Error).message}`);
    }
  }

  // ── Legacy patch helpers (v1 compat, thin wrappers) ────────

  async createPatch(repoId: string, authorId: string, data: { title: string; description?: string; source_branch: string; target_branch?: string }): Promise<Record<string, unknown>> {
    const { title, description = '', source_branch, target_branch = 'main' } = data;
    const result = await this.store.query(
      `INSERT INTO patches (repo_id, author_id, title, description, source_branch, target_branch)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      [repoId, authorId, title, description, source_branch, target_branch]
    );
    return result.rows[0];
  }

  async listPatches(repoId: string, status: string | null = null): Promise<Record<string, unknown>[]> {
    let sql = `SELECT p.*, a.name as author_name FROM patches p
               LEFT JOIN agents a ON p.author_id = a.id WHERE p.repo_id = ?`;
    const params: unknown[] = [repoId];
    if (status) { sql += ` AND p.status = ?`; params.push(status); }
    sql += ` ORDER BY p.created_at DESC`;
    return (await this.store.query(sql, params)).rows;
  }

  // ── Council sync helpers ────────────────────────────────────

  /**
   * Create a council proposal with Mode B sync.
   */
  async createProposal(repoId: string, proposal: Record<string, unknown>, agentId: string): Promise<Record<string, unknown>> {
    const result = await (this.council as any).createProposal(repoId, proposal, agentId);

    if (this.sync) {
      try {
        await this.sync.syncCouncilProposal(repoId, { ...proposal, id: result?.id, proposed_by: agentId });
      } catch {
        this.sync._queueEvent({ type: 'council_proposal', data: {
          repoId, proposal: { ...proposal, id: result?.id, proposed_by: agentId },
        }});
      }
    }
    return result;
  }

  /**
   * Cast a council vote with Mode B sync.
   */
  async castVote(repoId: string, proposalId: string, agentId: string, vote: string, comment: string = ''): Promise<Record<string, unknown>> {
    const result = await (this.council as any).castVote(proposalId, agentId, vote, comment);

    if (this.sync) {
      try {
        await this.sync.syncCouncilVote(repoId, proposalId, { agent_id: agentId, vote, comment });
      } catch {
        this.sync._queueEvent({ type: 'council_vote', data: {
          repoId, proposalId, agent_id: agentId, vote, comment,
        }});
      }
    }
    return result;
  }

  // ── Stage sync helper ─────────────────────────────────────

  /**
   * Progress repo stage with Mode B sync.
   */
  async progressStage(repoId: string, fromStage: string, toStage: string, metrics: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await (this.stages as any).progressStage(repoId, fromStage, toStage, metrics);

    if (this.sync) {
      try {
        await this.sync.syncStageProgression(repoId, { fromStage, toStage, metrics });
      } catch {
        this.sync._queueEvent({ type: 'stage_progression', data: {
          repoId, fromStage, toStage, metrics,
        }});
      }
    }
    return result;
  }

  // ── Builtin plugin runner (Tier 1 only) ────────────────────

  /**
   * Check if the repo has .gitswarm/plugins.yml with Tier 2/3 plugins
   * that require a server connection to execute. Returns warnings.
   */
  checkPluginCompatibility(): string[] {
    const pluginsPath = join(this.repoPath, '.gitswarm', 'plugins.yml');
    if (!existsSync(pluginsPath)) return [];

    const content = readFileSync(pluginsPath, 'utf-8');
    const warnings: string[] = [];

    // Simple heuristic: check for Tier 2/3 indicators
    const tier2Indicators = ['engine:', 'model:', 'dispatch'];
    const tier3Indicators = ['consensus_reached', 'council', 'governance'];

    const hasTier2 = tier2Indicators.some(i => content.includes(i));
    const hasTier3 = tier3Indicators.some(i => content.includes(i));

    if (hasTier2 && !this.sync) {
      warnings.push('Tier 2 (AI-augmented) plugins in plugins.yml require a server connection to execute.');
    }
    if (hasTier3 && !this.sync) {
      warnings.push('Tier 3 (governance) plugins in plugins.yml require a server connection to execute.');
    }

    return warnings;
  }

  /**
   * Fire builtin plugins for a given trigger event.
   * Only handles Tier 1 (deterministic automations) locally.
   * Tier 2 (AI) and Tier 3 (governance) are server-only.
   */
  async _fireBuiltinPlugins(trigger: string, repo: Record<string, unknown>, eventData: Record<string, unknown>): Promise<void> {
    // Merge builtin plugins with plugins.yml definitions for this trigger.
    // plugins.yml can override safe_outputs for builtins (matched by action name).
    const yamlPlugins = this.loadPlugins();
    const builtinNames = Object.keys(BUILTIN_PLUGINS);

    // Log any plugins.yml entries for this trigger that aren't handled locally.
    // These are Tier 2/3 plugins that require a server connection.
    const skippedPlugins = yamlPlugins.filter((p: ParsedPlugin) =>
      p.enabled &&
      p.trigger_event === `gitswarm.${trigger}` &&
      !p.actions.some((a: unknown) => builtinNames.includes(a as string))
    );
    if (skippedPlugins.length > 0) {
      const names = skippedPlugins.map((p: ParsedPlugin) => p.name).join(', ');
      await this.activity.log({
        event_type: 'plugins_skipped_no_server',
        target_type: 'repo',
        target_id: repo.id as string,
        metadata: {
          trigger,
          skipped: names,
          reason: 'Tier 2/3 plugins require a server connection',
        },
      });
    }

    for (const [name, plugin] of Object.entries(BUILTIN_PLUGINS)) {
      if (plugin.trigger !== trigger) continue;

      // Find matching plugin.yml definition for safe_outputs constraints
      const yamlMatch = yamlPlugins.find((p: ParsedPlugin) =>
        p.enabled && p.actions.includes(name) && p.trigger_event === `gitswarm.${trigger}`
      );
      const safeOutputsDef = yamlMatch?.safe_outputs || {};

      // Create execution context with safe-outputs budget
      const context = this.safeOutputs.createContext({
        name: yamlMatch?.name || name,
        safe_outputs: safeOutputsDef as any,
      });

      // Check rate limits
      const rateCheck = this.safeOutputs.checkRateLimit(
        yamlMatch?.name || name,
        context.limits
      );
      if (!rateCheck.allowed) {
        await this.activity.log({
          event_type: 'plugin_rate_limited',
          target_type: 'repo',
          target_id: repo.id as string,
          metadata: { plugin: name, trigger, reason: rateCheck.reason },
        });
        continue;
      }

      // Check action budget before executing
      const actionCheck = this.safeOutputs.checkAction(context, name);
      if (!actionCheck.allowed) {
        await this.activity.log({
          event_type: 'plugin_blocked',
          target_type: 'repo',
          target_id: repo.id as string,
          metadata: { plugin: name, trigger, reason: actionCheck.reason },
        });
        continue;
      }

      try {
        const result = await plugin.execute(this, repo, eventData);
        this.safeOutputs.recordAction(context, name);

        // Log execution for rate limiting tracking
        await this.activity.log({
          event_type: 'plugin_executed',
          target_type: 'repo',
          target_id: repo.id as string,
          metadata: {
            plugin: yamlMatch?.name || name,
            trigger,
            result: result?.skipped ? 'skipped' : 'executed',
            safe_outputs: this.safeOutputs.getSummary(context),
          },
        });
      } catch (err: unknown) {
        // Log but don't throw — plugins are non-fatal
        await this.activity.log({
          event_type: 'plugin_error',
          target_type: 'repo',
          target_id: repo.id as string,
          metadata: { plugin: name, trigger, error: (err as Error).message },
        });
      }
    }
  }

  // ── Server updates polling ─────────────────────────────────

  /**
   * Poll the server for updates relevant to this agent.
   * Returns task assignments, access changes, reviews, merges, and config changes.
   * Applies remote review updates to local patch_reviews table for consistency.
   */
  async pollUpdates(): Promise<Record<string, unknown> | null> {
    if (!this.sync) return null;
    try {
      const cfg = this.config();
      const since = (cfg._lastPoll as string) || new Date(0).toISOString();
      const updates = await this.sync.pollUpdates(since) as Record<string, unknown>;

      // Apply remote reviews to local patch_reviews table (Fix #10: bidirectional sync)
      if (updates.reviews && (updates.reviews as unknown[]).length > 0) {
        for (const review of updates.reviews as Record<string, unknown>[]) {
          try {
            await this.store.query(
              `INSERT OR IGNORE INTO patch_reviews (stream_id, reviewer_id, verdict, feedback, is_human)
               VALUES (?, ?, ?, ?, 0)`,
              [review.stream_id, review.reviewer_id, review.verdict, review.feedback || '']
            );
          } catch {
            // May already exist — non-fatal
          }
        }
      }

      // If config changed on server, pull latest config
      if (updates.config_changes && (updates.config_changes as unknown[]).length > 0) {
        try {
          await this.pullConfig();
        } catch {
          // Non-fatal
        }
      }

      // Persist poll timestamp
      this._saveConfig({ _lastPoll: new Date().toISOString() });

      return updates;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.tracker) {
      try { this.tracker.close(); } catch {}
      this.tracker = null;
    }
    this.store.close();
  }

  // ── internal ──────────────────────────────────────────────

  static findSwarmDir(startPath: string): string | null {
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

  _generateKey(): string {
    return 'gsw_' + randomBytes(24).toString('hex');
  }

  _hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}

// ── git helpers ──────────────────────────────────────────────
// Minimal git CLI wrappers used only for operations not covered by git-cascade
// (e.g., promotion ff-merge, buffer branch creation, tagging).

function _git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function _gitSafe(cwd: string, cmd: string): string | null {
  try { return _git(cwd, cmd); } catch { return null; }
}
