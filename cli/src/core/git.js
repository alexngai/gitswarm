/**
 * Local git operations.
 *
 * Thin wrapper around `git` CLI for branch management, diff inspection,
 * and merge coordination.  Replaces the GitHub API used by the web app.
 */
import { execSync } from 'child_process';

export class GitOps {
  constructor(repoPath) {
    this.cwd = repoPath;
  }

  _run(cmd) {
    return execSync(cmd, { cwd: this.cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
  }

  _tryRun(cmd) {
    try { return this._run(cmd); } catch { return null; }
  }

  /** Check if directory is a git repo. */
  isRepo() {
    return this._tryRun('git rev-parse --is-inside-work-tree') === 'true';
  }

  /** Get the repo root directory. */
  root() {
    return this._run('git rev-parse --show-toplevel');
  }

  /** Current branch name. */
  currentBranch() {
    return this._run('git rev-parse --abbrev-ref HEAD');
  }

  /** List all local branches. */
  branches() {
    const raw = this._run('git branch --format="%(refname:short)"');
    return raw.split('\n').filter(Boolean);
  }

  /** Get recent commits (default 20). */
  log(n = 20, branch = null) {
    const ref = branch || '';
    const raw = this._run(
      `git log ${ref} --format="%H|%an|%ae|%s|%ci" -n ${n}`
    );
    return raw.split('\n').filter(Boolean).map(line => {
      const [hash, author, email, subject, date] = line.split('|');
      return { hash, author, email, subject, date };
    });
  }

  /** Diff between two refs. */
  diff(base, head = 'HEAD') {
    return this._tryRun(`git diff ${base}...${head} --stat`) || '';
  }

  /** Full diff content. */
  diffFull(base, head = 'HEAD') {
    return this._tryRun(`git diff ${base}...${head}`) || '';
  }

  /** List changed files between two refs. */
  changedFiles(base, head = 'HEAD') {
    const raw = this._tryRun(`git diff ${base}...${head} --name-only`);
    return raw ? raw.split('\n').filter(Boolean) : [];
  }

  /** Create a new branch from current HEAD. */
  createBranch(name) {
    this._run(`git branch "${name}"`);
  }

  /** Merge a branch into current branch. */
  merge(branch, noFf = true) {
    const flag = noFf ? '--no-ff' : '';
    return this._run(`git merge ${flag} "${branch}"`);
  }

  /** Check if a branch exists. */
  branchExists(name) {
    return this._tryRun(`git rev-parse --verify "${name}"`) !== null;
  }

  /** Get the status summary. */
  status() {
    return this._run('git status --short');
  }

  /** Check for uncommitted changes. */
  isDirty() {
    return this.status().length > 0;
  }

  /** Get contributors (unique authors of commits). */
  contributors(branch = null) {
    const ref = branch || 'HEAD';
    const raw = this._run(`git log ${ref} --format="%an|%ae" | sort -u`);
    return raw.split('\n').filter(Boolean).map(line => {
      const [name, email] = line.split('|');
      return { name, email };
    });
  }
}
