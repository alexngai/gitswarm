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
   * Posts the merge record and updates stream status.
   */
  async syncMergeCompleted(repoId, streamId, { mergeCommit, targetBranch }) {
    // Record the merge with commit data
    await this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/merge`, {
      merge_commit: mergeCommit,
      target_branch: targetBranch,
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

  // ── Repo Registration (Mode B first-connect) ───────────────

  /**
   * Register a CLI repo with the server.
   * Server creates a personal org if needed and assigns the repo to it.
   */
  async registerRepo(repo) {
    return this._post('/gitswarm/repos/register', {
      name: repo.name,
      description: repo.description,
      ownership_model: repo.ownershipModel,
      merge_mode: repo.mergeMode,
      consensus_threshold: repo.consensusThreshold,
      min_reviews: repo.minReviews,
      buffer_branch: repo.bufferBranch,
      promote_target: repo.promoteTarget,
    });
  }

  /**
   * Fetch server config for a repo (server-owned settings).
   */
  async getRepoConfig(repoId) {
    return this._get(`/gitswarm/repos/${repoId}/config`);
  }

  // ── Council Sync ──────────────────────────────────────────

  async syncCouncilProposal(repoId, proposal) {
    return this._post(`/gitswarm/repos/${repoId}/council/proposals`, proposal);
  }

  async syncCouncilVote(repoId, proposalId, vote) {
    return this._post(`/gitswarm/repos/${repoId}/council/proposals/${proposalId}/votes`, vote);
  }

  // ── Stage Sync ────────────────────────────────────────────

  async syncStageProgression(repoId, { fromStage, toStage, metrics }) {
    return this._post(`/gitswarm/repos/${repoId}/stage`, {
      from_stage: fromStage,
      to_stage: toStage,
      metrics,
    });
  }

  // ── Task Sync ─────────────────────────────────────────────

  async syncTaskSubmission(taskId, { streamId, notes }) {
    return this._post(`/gitswarm/tasks/${taskId}/submit`, {
      agent_id: this.agentId,
      stream_id: streamId,
      submission_notes: notes,
    });
  }

  // ── Plugin Queries ────────────────────────────────────────

  async getPluginExecutions(repoId, { limit = 10 } = {}) {
    return this._get(`/gitswarm/repos/${repoId}/plugins/executions?limit=${limit}`);
  }

  // ── Server Updates Polling ────────────────────────────────

  /**
   * Poll for updates relevant to this agent since a given timestamp.
   * Returns task assignments, access changes, council proposals, etc.
   */
  async pollUpdates(since) {
    return this._get(`/gitswarm/updates?since=${encodeURIComponent(since)}&agent_id=${this.agentId}`);
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
   * Flush queued events to server using the batch sync endpoint.
   * Falls back to individual dispatch if batch endpoint is unavailable.
   */
  async flushQueue() {
    if (!this.store) return { flushed: 0, remaining: 0 };

    let events;
    try {
      events = await this.store.query(
        `SELECT * FROM sync_queue ORDER BY id ASC LIMIT 100`
      );
    } catch {
      return { flushed: 0, remaining: 0 };
    }

    if (!events.rows.length) return { flushed: 0, remaining: 0 };

    // Try batch endpoint first
    try {
      const batch = events.rows.map(e => ({
        seq: e.id,
        type: e.event_type,
        data: JSON.parse(e.payload),
        created_at: e.created_at,
      }));

      const response = await this._post('/gitswarm/sync/batch', { events: batch });

      // Delete successfully processed events
      let flushed = 0;
      for (const r of (response.results || [])) {
        if (r.status === 'ok' || r.status === 'duplicate') {
          try {
            await this.store.query('DELETE FROM sync_queue WHERE id = ?', [r.seq]);
          } catch { /* ignore */ }
          flushed++;
        } else {
          break; // Stop at first error to preserve ordering
        }
      }

      const remaining = await this.store.query('SELECT COUNT(*) as count FROM sync_queue');
      return { flushed, remaining: remaining.rows[0]?.count || 0 };
    } catch (err) {
      // Batch endpoint unavailable — fall back to individual dispatch
      if (err.status === 404) {
        return this._flushQueueIndividual(events.rows);
      }
      throw err;
    }
  }

  /**
   * Fallback: flush queue by dispatching events individually.
   */
  async _flushQueueIndividual(events) {
    let flushed = 0;
    for (const event of events) {
      try {
        const data = JSON.parse(event.payload);
        await this._dispatchQueuedEvent(event.event_type, data);
        await this.store.query(`DELETE FROM sync_queue WHERE id = ?`, [event.id]);
        flushed++;
      } catch {
        // Update attempt count
        try {
          await this.store.query(
            `UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            [String(arguments[0]?.message || 'unknown'), event.id]
          );
        } catch { /* ignore */ }
        break; // Stop on first failure (preserve ordering)
      }
    }
    return { flushed, remaining: events.length - flushed };
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
      case 'merge_requested':
        return this.requestMerge(data.repoId, data.streamId);
      case 'stabilize':
        return this.syncStabilization(data.repoId, data);
      case 'promote':
        return this.syncPromotion(data.repoId, data);
      case 'stream_abandoned':
        return this.syncStreamAbandoned(data.repoId, data.streamId, data.reason);
      case 'council_proposal':
        return this.syncCouncilProposal(data.repoId, data.proposal);
      case 'council_vote':
        return this.syncCouncilVote(data.repoId, data.proposalId, data);
      case 'stage_progression':
        return this.syncStageProgression(data.repoId, data);
      case 'task_submission':
        return this.syncTaskSubmission(data.taskId, data);
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
