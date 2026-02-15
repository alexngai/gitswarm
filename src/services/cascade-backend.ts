/**
 * Cascade Backend
 *
 * Wraps GitCascadeManager behind the GitBackend interface.
 * Used for Mode C repos where the server manages git locally.
 */
import { execSync } from 'child_process';
import { GitBackend } from './git-backend.js';
import { GitCascadeManager, gitCascadeManager } from './git-cascade-manager.js';
import { query } from '../config/database.js';

export class CascadeBackend extends GitBackend {
  private manager: GitCascadeManager;

  constructor(manager: GitCascadeManager | null = null) {
    super();
    this.manager = manager || gitCascadeManager;
  }

  async readFile(repoId: string, path: string, ref?: string): Promise<{ content: string; path: string }> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const targetRef = ref || 'buffer';
    const content = execSync(
      `git show "${targetRef}:${path}"`,
      { cwd: ctx.repoPath, encoding: 'utf-8' }
    );

    return { content, path };
  }

  async listDirectory(repoId: string, path: string, ref?: string): Promise<Array<{ name: string; path: string; type: string; sha: string }>> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const targetRef = ref || 'buffer';
    const treePath = path ? `${targetRef}:${path}` : `${targetRef}:`;

    const output = execSync(
      `git ls-tree "${treePath}"`,
      { cwd: ctx.repoPath, encoding: 'utf-8' }
    );

    return output.trim().split('\n').filter(Boolean).map(line => {
      const [info, name] = line.split('\t');
      const [, type, sha] = info.split(/\s+/);
      return { name, path: path ? `${path}/${name}` : name, type: type === 'tree' ? 'dir' : 'file', sha };
    });
  }

  async getTree(repoId: string, ref?: string): Promise<{ tree: Array<{ path: string; type: string; sha: string; mode: string }>; truncated: boolean }> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const targetRef = ref || 'buffer';
    const output = execSync(
      `git ls-tree -r "${targetRef}"`,
      { cwd: ctx.repoPath, encoding: 'utf-8' }
    );

    const tree = output.trim().split('\n').filter(Boolean).map(line => {
      const [info, filePath] = line.split('\t');
      const [mode, type, sha] = info.split(/\s+/);
      return { path: filePath, type: type === 'blob' ? 'file' : 'dir', sha, mode };
    });

    return { tree, truncated: false };
  }

  async getCommits(repoId: string, options: Record<string, unknown> = {}): Promise<Array<{ sha: string; message: string; author: { name: string; email: string; date: string } }>> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const ref = options.sha || 'buffer';
    const limit = options.per_page || 30;
    let cmd = `git log "${ref}" --format="%H|%an|%ae|%aI|%s" -n ${limit}`;
    if (options.path) cmd += ` -- "${options.path}"`;

    const output = execSync(cmd, { cwd: ctx.repoPath, encoding: 'utf-8' });

    return output.trim().split('\n').filter(Boolean).map(line => {
      const [sha, name, email, date, ...msgParts] = line.split('|');
      return {
        sha,
        message: msgParts.join('|'),
        author: { name, email, date },
      };
    });
  }

  async getBranches(repoId: string): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    const output = execSync(
      'git for-each-ref --format="%(refname:short) %(objectname:short)" refs/heads/',
      { cwd: ctx.repoPath, encoding: 'utf-8' }
    );

    return output.trim().split('\n').filter(Boolean).map(line => {
      const [name, sha] = line.split(' ');
      return { name, sha, protected: name === 'main' || name === 'buffer' };
    });
  }

  async writeFile(repoId: string, path: string, content: string, message: string, branch: string, author?: { name: string; email: string }): Promise<{ commit: { sha: string; message: string } }> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    // Write via a temporary worktree checkout
    const { repoPath } = ctx;
    const currentBranch = execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf-8' }).trim();

    execSync(`git checkout "${branch || 'buffer'}"`, { cwd: repoPath, encoding: 'utf-8' });

    const { join } = await import('path');
    const { mkdirSync, writeFileSync } = await import('fs');
    const fullPath = join(repoPath, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);

    execSync(`git add "${path}"`, { cwd: repoPath, encoding: 'utf-8' });

    let authorArg = '';
    if (author?.name && author?.email) {
      authorArg = `--author="${author.name} <${author.email}>"`;
    }
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}" ${authorArg}`, { cwd: repoPath, encoding: 'utf-8' });

    const sha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

    // Restore previous branch
    if (currentBranch && currentBranch !== (branch || 'buffer')) {
      execSync(`git checkout "${currentBranch}"`, { cwd: repoPath, encoding: 'utf-8' });
    }

    return { commit: { sha, message } };
  }

  async createBranch(repoId: string, name: string, fromRef: string): Promise<{ ref: string; sha: string }> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);

    execSync(`git branch "${name}" "${fromRef}"`, { cwd: ctx.repoPath, encoding: 'utf-8' });
    const sha = execSync(`git rev-parse "${name}"`, { cwd: ctx.repoPath, encoding: 'utf-8' }).trim();

    return { ref: `refs/heads/${name}`, sha };
  }

  async createPullRequest(repoId: string, prData: { title: string; head: string; base?: string }): Promise<Record<string, unknown>> {
    // Mode C doesn't use GitHub PRs — create a stream instead
    const streamId = `api-${Date.now()}`;
    await query(`
      INSERT INTO gitswarm_streams (id, repo_id, name, branch, source, base_branch)
      VALUES ($1, $2, $3, $4, 'api', $5)
    `, [streamId, repoId, prData.title, prData.head, prData.base || 'buffer']);

    return { stream_id: streamId, title: prData.title, head: prData.head, base: prData.base };
  }

  async mergePullRequest(repoId: string, streamId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    // In Mode C, "merging a PR" means merging the stream to buffer
    return this.manager.mergeToBuffer(repoId, streamId);
  }

  async getCloneAccess(repoId: string): Promise<{ cloneUrl: null; message: string }> {
    const ctx = await this.manager.getTracker(repoId);
    if (!ctx) throw new Error(`Repo ${repoId} not initialized for Mode C`);
    // Server-managed repos are accessed via the API, not cloned
    return { cloneUrl: null, message: 'Mode C repos are accessed via the file API' };
  }
}
