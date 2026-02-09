/**
 * CLI Sync Client for Mode B (Server-Coordinated)
 *
 * HTTP client that reports local git-cascade operations to the web server.
 * The protocol is idempotent: the CLI can retry any call safely.
 *
 * When the server is unreachable, operations queue locally and sync
 * when connectivity returns.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

export class SyncClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl - Base URL of the web server (e.g. http://localhost:3000/api/v1)
   * @param {string} opts.apiKey    - Agent API key for authentication
   * @param {string} opts.agentId   - Agent UUID
   * @param {object} opts.store     - SQLite store for queuing offline events
   */
  constructor({ serverUrl, apiKey, agentId, store = null }) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.store = store;
    this.online = true;
  }

  // ── Core HTTP ────────────────────────────────────────────────

  async _fetch(method, path, body = null) {
    const url = `${this.serverUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const opts = { method, headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        this.online = true;

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const err = new Error(errBody.error || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = errBody;
          throw err;
        }

        return res.json();
      } catch (err) {
        if (err.status) throw err; // HTTP error, don't retry

        // Network error: retry with backoff
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }

        this.online = false;
        throw err;
      }
    }
  }

  async _get(path) { return this._fetch('GET', path); }
  async _post(path, body) { return this._fetch('POST', path, body); }
  async _patch(path, body) { return this._fetch('PATCH', path, body); }
  async _delete(path) { return this._fetch('DELETE', path); }
  async _put(path, body) { return this._fetch('PUT', path, body); }

  // ── Stream Lifecycle Sync ───────────────────────────────────

  /**
   * Report stream creation to server.
   * CLI calls this after git-cascade createStream + createWorktree.
   */
  async syncStreamCreated(repoId, { streamId, name, branch, baseBranch, parentStreamId, taskId }) {
    return this._post(`/gitswarm/repos/${repoId}/streams`, {
      id: streamId,
      name,
      branch,
      agent_id: this.agentId,
      source: 'cli',
      base_branch: baseBranch,
      parent_stream_id: parentStreamId,
    });
  }

  /**
   * Report a commit to server.
   * CLI calls this after git-cascade commitChanges.
   */
  async syncCommit(repoId, streamId, { commitHash, changeId, message }) {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/commits`, {
      commit_hash: commitHash,
      change_id: changeId,
      message,
      agent_id: this.agentId,
    });
  }

  /**
   * Submit stream for review on server.
   */
  async syncSubmitForReview(repoId, streamId) {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/submit-review`, {});
  }

  /**
   * Submit a review verdict on a stream.
   */
  async syncReview(repoId, streamId, { verdict, feedback, tested = false }) {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/reviews`, {
      verdict,
      feedback,
      tested,
      reviewer_id: this.agentId,
    });
  }

  /**
   * Check consensus status for a stream (server authority).
   */
  async checkConsensus(repoId, streamId) {
    return this._get(`/gitswarm/repos/${repoId}/streams/${streamId}/consensus`);
  }

  /**
   * Request merge approval from server.
   * Returns { approved: true/false, consensus, bufferBranch }.
   * CLI performs the actual git merge locally if approved.
   */
  async requestMerge(repoId, streamId) {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/merge`, {});
  }

  /**
   * Report successful merge to server (after CLI does git merge + push).
   */
  async syncMergeCompleted(repoId, streamId, { mergeCommit, targetBranch }) {
    return this._patch(`/gitswarm/repos/${repoId}/streams/${streamId}`, {
      status: 'merged',
    });
  }

  /**
   * Report stream abandoned.
   */
  async syncStreamAbandoned(repoId, streamId, reason = '') {
    return this._delete(`/gitswarm/repos/${repoId}/streams/${streamId}?reason=${encodeURIComponent(reason)}`);
  }

  // ── Stabilization & Promotion ────────────────────────────────

  /**
   * Get current buffer state (commit hash) from server.
   * Agents use this to know what to stabilize against.
   */
  async getBufferState(repoId) {
    return this._get(`/gitswarm/repos/${repoId}/buffer-state`);
  }

  /**
   * Report stabilization result.
   * Stabilization runs are performed by external agents, not the server.
   */
  async syncStabilization(repoId, { result, tag, bufferCommit, breakingStreamId, details }) {
    return this._post(`/gitswarm/repos/${repoId}/stabilize`, {
      result,
      tag,
      buffer_commit: bufferCommit,
      breaking_stream_id: breakingStreamId,
      details,
    });
  }

  /**
   * Report promotion (buffer -> main).
   */
  async syncPromotion(repoId, { fromCommit, toCommit, triggeredBy = 'manual' }) {
    return this._post(`/gitswarm/repos/${repoId}/promote`, {
      from_commit: fromCommit,
      to_commit: toCommit,
      triggered_by: triggeredBy,
    });
  }

  // ── Task & Data Queries ──────────────────────────────────────

  /**
   * Fetch available tasks for a repo.
   */
  async listTasks(repoId, { status = 'open', limit = 50 } = {}) {
    return this._get(`/gitswarm/repos/${repoId}/tasks?status=${status}&limit=${limit}`);
  }

  /**
   * Claim a task.
   */
  async claimTask(taskId, { streamId } = {}) {
    return this._post(`/gitswarm/tasks/${taskId}/claim`, {
      agent_id: this.agentId,
      stream_id: streamId,
    });
  }

  /**
   * List streams for a repo.
   */
  async listStreams(repoId, { status, limit = 50 } = {}) {
    let path = `/gitswarm/repos/${repoId}/streams?limit=${limit}`;
    if (status) path += `&status=${status}`;
    return this._get(path);
  }

  // ── Bulk Sync (Offline Recovery) ─────────────────────────────

  /**
   * Queue an event locally for later sync.
   * Used when server is unreachable.
   */
  async _queueEvent(event) {
    if (!this.store) return;
    try {
      await this.store.query(
        `INSERT INTO sync_queue (event_type, payload, created_at)
         VALUES (?, ?, ?)`,
        [event.type, JSON.stringify(event.data), new Date().toISOString()]
      );
    } catch {
      // sync_queue table may not exist in older schemas
    }
  }

  /**
   * Flush queued events to server.
   * Called when connectivity is restored.
   */
  async flushQueue() {
    if (!this.store) return { flushed: 0 };

    let events;
    try {
      events = await this.store.query(
        `SELECT * FROM sync_queue ORDER BY created_at ASC`
      );
    } catch {
      return { flushed: 0 };
    }

    let flushed = 0;
    for (const event of events.rows) {
      try {
        const data = JSON.parse(event.payload);
        await this._dispatchQueuedEvent(event.event_type, data);
        await this.store.query(`DELETE FROM sync_queue WHERE id = ?`, [event.id]);
        flushed++;
      } catch {
        break; // Stop on first failure (preserve ordering)
      }
    }

    return { flushed, remaining: events.rows.length - flushed };
  }

  async _dispatchQueuedEvent(type, data) {
    switch (type) {
      case 'stream_created':
        return this.syncStreamCreated(data.repoId, data);
      case 'commit':
        return this.syncCommit(data.repoId, data.streamId, data);
      case 'submit_review':
        return this.syncSubmitForReview(data.repoId, data.streamId);
      case 'review':
        return this.syncReview(data.repoId, data.streamId, data);
      case 'merge':
        return this.syncMergeCompleted(data.repoId, data.streamId, data);
      case 'stabilize':
        return this.syncStabilization(data.repoId, data);
      case 'promote':
        return this.syncPromotion(data.repoId, data);
      default:
        throw new Error(`Unknown queued event type: ${type}`);
    }
  }

  // ── Health ──────────────────────────────────────────────────

  async ping() {
    try {
      await this._get('/health');
      this.online = true;
      return true;
    } catch {
      this.online = false;
      return false;
    }
  }

  isOnline() {
    return this.online;
  }
}
