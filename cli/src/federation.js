/**
 * Federation — the top-level context for a local gitswarm instance.
 *
 * Encapsulates the SQLite store and all core services.  Every CLI command
 * receives a Federation instance so it can access agents, tasks, reviews,
 * council governance, etc. without knowing about the database.
 *
 * Usage:
 *   const fed = Federation.open('/path/to/repo');
 *   const agents = await fed.agents.list();
 *   fed.close();
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { SqliteStore } from './store/sqlite.js';
import { PermissionService } from './core/permissions.js';
import { TaskService } from './core/tasks.js';
import { CouncilService } from './core/council.js';
import { StageService } from './core/stages.js';
import { ActivityService } from './core/activity.js';
import { GitOps } from './core/git.js';

const GITSWARM_DIR = '.gitswarm';
const DB_FILE = 'federation.db';
const CONFIG_FILE = 'config.json';

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
    this.git         = new GitOps(repoPath);
  }

  /**
   * Open (or initialise) a federation at the given repo path.
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
    return new Federation(join(swarmDir, '..'), store);
  }

  /**
   * Initialise a new federation in the given repo path.
   */
  static init(repoPath, options = {}) {
    const swarmDir = join(repoPath, GITSWARM_DIR);

    if (existsSync(join(swarmDir, DB_FILE))) {
      throw new Error('Federation already initialised in this repository.');
    }

    const dbPath = join(swarmDir, DB_FILE);
    const store = new SqliteStore(dbPath);
    store.migrate();

    // Write default config
    const config = {
      name: options.name || repoPath.split('/').pop(),
      ownership_model: options.ownership_model || 'solo',
      agent_access: options.agent_access || 'public',
      consensus_threshold: options.consensus_threshold ?? 0.66,
      min_reviews: options.min_reviews ?? 1,
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(swarmDir, CONFIG_FILE), JSON.stringify(config, null, 2));

    // Create the repo record
    store.query(
      `INSERT INTO repos (name, path, ownership_model, agent_access, consensus_threshold, min_reviews)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [config.name, repoPath, config.ownership_model, config.agent_access, config.consensus_threshold, config.min_reviews]
    );

    const fed = new Federation(repoPath, store);
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

  // ── Agent helpers (thin wrappers for CLI convenience) ──────

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

  // ── Patch helpers ─────────────────────────────────────────

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

  async submitReview(patchId, reviewerId, verdict, feedback = '') {
    const result = await this.store.query(
      `INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET verdict = ?, feedback = ?, reviewed_at = datetime('now')
       RETURNING *`,
      [patchId, reviewerId, verdict, feedback, verdict, feedback]
    );
    return result.rows[0];
  }

  async getReviews(patchId) {
    return (await this.store.query(
      `SELECT pr.*, a.name as reviewer_name FROM patch_reviews pr
       LEFT JOIN agents a ON pr.reviewer_id = a.id WHERE pr.patch_id = ?
       ORDER BY pr.reviewed_at`,
      [patchId]
    )).rows;
  }

  close() {
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
