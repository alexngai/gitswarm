/**
 * Buffer Merge Lock
 *
 * Prevents concurrent merges to the buffer branch by using a lock file
 * in the .gitswarm directory. This protects against race conditions when
 * multiple agents try to merge simultaneously.
 *
 * The lock is acquired before a merge and released after (including on failure).
 * Stale locks (older than the timeout) are automatically cleaned up.
 */
import { join } from 'path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';

const LOCK_FILE = 'merge.lock';
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes — merges shouldn't take longer

export class MergeLock {
  /**
   * @param {string} swarmDir - Path to .gitswarm directory
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Lock timeout in milliseconds
   */
  constructor(swarmDir, opts = {}) {
    this.lockPath = join(swarmDir, LOCK_FILE);
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Attempt to acquire the merge lock.
   * Returns true if lock was acquired, false if another merge is in progress.
   * Stale locks are automatically released.
   */
  acquire(agentId = 'unknown') {
    // Check for existing lock
    if (existsSync(this.lockPath)) {
      try {
        const lockData = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
        const lockAge = Date.now() - new Date(lockData.acquired_at).getTime();

        // If lock is still fresh, another merge is in progress
        if (lockAge < this.timeoutMs) {
          return {
            acquired: false,
            holder: lockData.agent_id,
            age_ms: lockAge,
            reason: `Buffer merge in progress by agent "${lockData.agent_id}" (${Math.round(lockAge / 1000)}s ago)`,
          };
        }

        // Stale lock — clean it up
        this._release();
      } catch {
        // Corrupt lock file — remove it
        this._release();
      }
    }

    // Acquire the lock
    const lockData = {
      agent_id: agentId,
      acquired_at: new Date().toISOString(),
      pid: process.pid,
    };

    try {
      writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2));
      return { acquired: true };
    } catch (err) {
      return { acquired: false, reason: `Failed to create lock file: ${err.message}` };
    }
  }

  /**
   * Release the merge lock.
   */
  release() {
    this._release();
  }

  _release() {
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file may have already been removed
    }
  }
}
