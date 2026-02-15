/**
 * Shared test helpers for gitswarm-cli tests.
 *
 * Provides:
 *  - createTestRepo(): spins up a temp git repo with an initial commit
 *  - createFederation(): init + register agents in a test repo
 *  - cleanup(): rm -rf temp dirs
 */
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Federation } from '../src/federation.js';
import { SqliteStore } from '../src/store/sqlite.js';

const tempDirs: string[] = [];

/**
 * Create a temp git repo with an initial commit.
 * Initializes a fresh repo with a single commit to provide working git history.
 */
export function createTestRepo(): string {
  const tmpBase = mkdtempSync(join(tmpdir(), 'gsw-test-'));
  tempDirs.push(tmpBase);

  const repoPath = join(tmpBase, 'repo');
  mkdirSync(repoPath, { recursive: true });

  // Initialize a fresh git repo
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });

  // Configure for local commits (no signing)
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "test"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: repoPath, stdio: 'pipe' });

  // Create initial commit on main branch
  execSync('git checkout -B main', { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# Test Project\n');
  execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: repoPath, stdio: 'pipe' });

  return repoPath;
}

/**
 * Create a bare-minimum SQLite store for unit tests (no git repo needed).
 */
export function createTestStore(): InstanceType<typeof SqliteStore> {
  const tmpBase = mkdtempSync(join(tmpdir(), 'gsw-store-'));
  tempDirs.push(tmpBase);
  const dbPath = join(tmpBase, 'test.db');
  const store = new SqliteStore(dbPath);
  store.migrate();
  return store;
}

/**
 * Create a test store and seed it with common test data.
 */
export function createSeededStore(): InstanceType<typeof SqliteStore> {
  const store = createTestStore();

  // Agents
  store.query("INSERT INTO agents (id, name, karma) VALUES ('agent-1', 'architect', 100)");
  store.query("INSERT INTO agents (id, name, karma) VALUES ('agent-2', 'coder', 50)");
  store.query("INSERT INTO agents (id, name, karma) VALUES ('agent-3', 'reviewer', 200)");

  // Repo
  store.query(`INSERT INTO repos (id, name, ownership_model, merge_mode, consensus_threshold, min_reviews, buffer_branch, promote_target)
    VALUES ('repo-1', 'test-project', 'guild', 'review', 0.66, 1, 'buffer', 'main')`);

  // Maintainers
  store.query("INSERT INTO maintainers (repo_id, agent_id, role) VALUES ('repo-1', 'agent-1', 'owner')");
  store.query("INSERT INTO maintainers (repo_id, agent_id, role) VALUES ('repo-1', 'agent-3', 'maintainer')");

  return store;
}

/**
 * Initialize a full Federation in a test git repo.
 */
export function createTestFederation(opts: Record<string, any> = {}) {
  const repoPath = createTestRepo();
  const { federation, config } = Federation.init(repoPath, {
    name: 'test-project',
    merge_mode: opts.merge_mode || 'review',
    ownership_model: opts.ownership_model || 'guild',
    ...opts,
  });
  return { federation, config, repoPath };
}

/**
 * Helper: write a file in a worktree and stage it.
 */
export function writeAndStage(worktreePath: string, filename: string, content: string): void {
  writeFileSync(join(worktreePath, filename), content);
  execSync(`git add "${filename}"`, { cwd: worktreePath, stdio: 'pipe' });
}

/**
 * Clean up all temp directories.
 */
export function cleanup(): void {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs.length = 0;
}
