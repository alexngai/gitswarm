/**
 * CLI Sync Client for Mode B (Server-Coordinated)
 *
 * HTTP client that reports local git-cascade operations to the web server.
 * The protocol is idempotent: the CLI can retry any call safely.
 *
 * When the server is unreachable, operations queue locally and sync
 * when connectivity returns.
 */
import type { SqliteStore } from './store/sqlite.js';

interface HttpError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

interface QueuedEvent {
  type: string;
  data: Record<string, unknown>;
}

interface FlushResult {
  flushed: number;
  remaining: number;
  failedTypes: string[];
}

interface SyncClientOptions {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  store?: SqliteStore | null;
}

interface StreamCreatedData {
  streamId: string;
  name: string;
  branch: string;
  baseBranch?: string;
  parentStreamId?: string;
  taskId?: string;
}

interface CommitData {
  commitHash: string;
  changeId?: string;
  message: string;
}

interface ReviewData {
  verdict: string;
  feedback?: string;
  tested?: boolean;
}

interface MergeCompletedData {
  mergeCommit: string;
  targetBranch: string;
}

interface StabilizationData {
  result: string;
  tag?: string;
  bufferCommit?: string;
  breakingStreamId?: string;
  details?: unknown;
}

interface PromotionData {
  fromCommit: string;
  toCommit: string;
  triggeredBy?: string;
}

interface RepoRegistrationData {
  name: string;
  description?: string;
  ownershipModel?: string;
  mergeMode?: string;
  consensusThreshold?: number;
  minReviews?: number;
  bufferBranch?: string;
  promoteTarget?: string;
}

interface StageProgressionData {
  fromStage: string;
  toStage: string;
  metrics: Record<string, unknown>;
}

interface TaskSubmissionData {
  streamId?: string;
  notes?: string;
}

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAYS: number[] = [1000, 2000, 4000]; // exponential backoff

export class SyncClient {
  private serverUrl: string;
  private apiKey: string;
  agentId: string;
  private store: SqliteStore | null;
  private online: boolean;

  /**
   * @param {object} opts
   * @param {string} opts.serverUrl - Base URL of the web server (e.g. http://localhost:3000/api/v1)
   * @param {string} opts.apiKey    - Agent API key for authentication
   * @param {string} opts.agentId   - Agent UUID
   * @param {object} opts.store     - SQLite store for queuing offline events
   */
  constructor({ serverUrl, apiKey, agentId, store = null }: SyncClientOptions) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.store = store;
    this.online = true;
  }

  // ── Core HTTP ────────────────────────────────────────────────

  async _fetch(method: string, path: string, body: Record<string, unknown> | null = null): Promise<unknown> {
    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        this.online = true;

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
          const err: HttpError = new Error((errBody.error as string) || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = errBody;
          throw err;
        }

        return res.json();
      } catch (err) {
        if ((err as HttpError).status) throw err; // HTTP error, don't retry

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

  async _get(path: string): Promise<unknown> { return this._fetch('GET', path); }
  async _post(path: string, body: Record<string, unknown>): Promise<unknown> { return this._fetch('POST', path, body); }
  async _patch(path: string, body: Record<string, unknown>): Promise<unknown> { return this._fetch('PATCH', path, body); }
  async _delete(path: string): Promise<unknown> { return this._fetch('DELETE', path); }
  async _put(path: string, body: Record<string, unknown>): Promise<unknown> { return this._fetch('PUT', path, body); }

  // ── Stream Lifecycle Sync ───────────────────────────────────

  /**
   * Report stream creation to server.
   * CLI calls this after git-cascade createStream + createWorktree.
   */
  async syncStreamCreated(repoId: string, { streamId, name, branch, baseBranch, parentStreamId, taskId }: StreamCreatedData): Promise<unknown> {
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
  async syncCommit(repoId: string, streamId: string, { commitHash, changeId, message }: CommitData): Promise<unknown> {
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
  async syncSubmitForReview(repoId: string, streamId: string): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/submit-review`, {});
  }

  /**
   * Submit a review verdict on a stream.
   */
  async syncReview(repoId: string, streamId: string, { verdict, feedback, tested = false }: ReviewData): Promise<unknown> {
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
  async checkConsensus(repoId: string, streamId: string): Promise<unknown> {
    return this._get(`/gitswarm/repos/${repoId}/streams/${streamId}/consensus`);
  }

  /**
   * Request merge approval from server.
   * Returns { approved: true/false, consensus, bufferBranch }.
   * CLI performs the actual git merge locally if approved.
   */
  async requestMerge(repoId: string, streamId: string): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/merge-request`, {});
  }

  /**
   * Report successful merge to server (after CLI does git merge + push).
   * Posts the merge record and updates stream status.
   */
  async syncMergeCompleted(repoId: string, streamId: string, { mergeCommit, targetBranch }: MergeCompletedData): Promise<void> {
    // Record the merge with commit data
    await this._post(`/gitswarm/repos/${repoId}/streams/${streamId}/merge`, {
      merge_commit: mergeCommit,
      target_branch: targetBranch,
    });
  }

  /**
   * Report stream abandoned.
   */
  async syncStreamAbandoned(repoId: string, streamId: string, reason: string = ''): Promise<unknown> {
    return this._delete(`/gitswarm/repos/${repoId}/streams/${streamId}?reason=${encodeURIComponent(reason)}`);
  }

  // ── Stabilization & Promotion ────────────────────────────────

  /**
   * Get current buffer state (commit hash) from server.
   * Agents use this to know what to stabilize against.
   */
  async getBufferState(repoId: string): Promise<unknown> {
    return this._get(`/gitswarm/repos/${repoId}/buffer-state`);
  }

  /**
   * Report stabilization result.
   * Stabilization runs are performed by external agents, not the server.
   */
  async syncStabilization(repoId: string, { result, tag, bufferCommit, breakingStreamId, details }: StabilizationData): Promise<unknown> {
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
  async syncPromotion(repoId: string, { fromCommit, toCommit, triggeredBy = 'manual' }: PromotionData): Promise<unknown> {
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
  async listTasks(repoId: string, { status = 'open', limit = 50 }: { status?: string; limit?: number } = {}): Promise<unknown> {
    return this._get(`/gitswarm/repos/${repoId}/tasks?status=${status}&limit=${limit}`);
  }

  /**
   * Claim a task.
   */
  async claimTask(repoId: string, taskId: string, { streamId }: { streamId?: string } = {}): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/tasks/${taskId}/claim`, {
      agent_id: this.agentId,
      stream_id: streamId,
    });
  }

  /**
   * List streams for a repo.
   */
  async listStreams(repoId: string, { status, limit = 50 }: { status?: string; limit?: number } = {}): Promise<unknown> {
    let path = `/gitswarm/repos/${repoId}/streams?limit=${limit}`;
    if (status) path += `&status=${status}`;
    return this._get(path);
  }

  // ── Repo Registration (Mode B first-connect) ───────────────

  /**
   * Register a CLI repo with the server.
   * Server creates a personal org if needed and assigns the repo to it.
   */
  async registerRepo(repo: RepoRegistrationData): Promise<unknown> {
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
  async getRepoConfig(repoId: string): Promise<unknown> {
    return this._get(`/gitswarm/repos/${repoId}/config`);
  }

  // ── Council Sync ──────────────────────────────────────────

  async syncCouncilProposal(repoId: string, proposal: Record<string, unknown>): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/council/proposals`, proposal);
  }

  async syncCouncilVote(repoId: string, proposalId: string, vote: Record<string, unknown>): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/council/proposals/${proposalId}/votes`, vote);
  }

  // ── Stage Sync ────────────────────────────────────────────

  async syncStageProgression(repoId: string, { fromStage, toStage, metrics }: StageProgressionData): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/stage`, {
      from_stage: fromStage,
      to_stage: toStage,
      metrics,
    });
  }

  // ── Task Sync ─────────────────────────────────────────────

  async syncTaskSubmission(repoId: string, taskId: string, claimId: string, { streamId, notes }: TaskSubmissionData): Promise<unknown> {
    return this._post(`/gitswarm/repos/${repoId}/tasks/${taskId}/claims/${claimId}/submit`, {
      agent_id: this.agentId,
      stream_id: streamId,
      submission_notes: notes,
    });
  }

  // ── Plugin Queries ────────────────────────────────────────

  async getPluginExecutions(repoId: string, { limit = 10 }: { limit?: number } = {}): Promise<unknown> {
    return this._get(`/gitswarm/repos/${repoId}/plugins/executions?limit=${limit}`);
  }

  // ── Server Updates Polling ────────────────────────────────

  /**
   * Poll for updates relevant to this agent since a given timestamp.
   * Returns task assignments, access changes, council proposals, etc.
   */
  async pollUpdates(since: string): Promise<unknown> {
    return this._get(`/gitswarm/updates?since=${encodeURIComponent(since)}&agent_id=${this.agentId}`);
  }

  // ── Bulk Sync (Offline Recovery) ─────────────────────────────

  /**
   * Queue an event locally for later sync.
   * Used when server is unreachable.
   */
  async _queueEvent(event: QueuedEvent): Promise<void> {
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
   * Returns structured result including which event types failed,
   * so callers (e.g. mergeToBuffer) can block on critical failures.
   */
  async flushQueue(): Promise<FlushResult> {
    if (!this.store) return { flushed: 0, remaining: 0, failedTypes: [] };

    let events;
    try {
      events = await this.store.query(
        `SELECT * FROM sync_queue ORDER BY id ASC LIMIT 100`
      );
    } catch {
      return { flushed: 0, remaining: 0, failedTypes: [] };
    }

    if (!events.rows.length) return { flushed: 0, remaining: 0, failedTypes: [] };

    // Try batch endpoint first
    try {
      const batch = events.rows.map(e => ({
        seq: e.id,
        type: e.event_type,
        data: JSON.parse(e.payload as string),
        created_at: e.created_at,
      }));

      const response = await this._post('/gitswarm/sync/batch', { events: batch }) as { results?: Array<{ seq: unknown; status: string }> };

      // Delete successfully processed events and track failures by type
      let flushed = 0;
      const failedTypes: string[] = [];
      const seqToType = Object.fromEntries(batch.map(b => [b.seq as string, b.type as string]));

      for (const r of (response.results || [])) {
        if (r.status === 'ok' || r.status === 'duplicate') {
          try {
            await this.store!.query('DELETE FROM sync_queue WHERE id = ?', [r.seq]);
          } catch { /* ignore */ }
          flushed++;
        } else {
          failedTypes.push(seqToType[r.seq as string] || 'unknown');
          break; // Stop at first error to preserve ordering
        }
      }

      // Events after the break point are also unflushed — collect their types
      const processedSeqs = new Set((response.results || [])
        .filter(r => r.status === 'ok' || r.status === 'duplicate')
        .map(r => r.seq));
      for (const e of events.rows) {
        if (!processedSeqs.has(e.id)) {
          const type = e.event_type as string;
          if (!failedTypes.includes(type)) failedTypes.push(type);
        }
      }

      const remaining = await this.store!.query('SELECT COUNT(*) as count FROM sync_queue');
      return { flushed, remaining: (remaining.rows[0]?.count as number) || 0, failedTypes };
    } catch (err) {
      // Batch endpoint unavailable — fall back to individual dispatch
      if ((err as HttpError).status === 404) {
        return this._flushQueueIndividual(events.rows);
      }
      throw err;
    }
  }

  /**
   * Fallback: flush queue by dispatching events individually.
   */
  async _flushQueueIndividual(events: Record<string, unknown>[]): Promise<FlushResult> {
    let flushed = 0;
    const failedTypes: string[] = [];
    for (const event of events) {
      try {
        const data = JSON.parse(event.payload as string) as Record<string, unknown>;
        await this._dispatchQueuedEvent(event.event_type as string, data);
        await this.store!.query(`DELETE FROM sync_queue WHERE id = ?`, [event.id]);
        flushed++;
      } catch (err) {
        failedTypes.push(event.event_type as string);
        // Update attempt count
        try {
          await this.store!.query(
            `UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            [String((err as Error)?.message || 'unknown'), event.id]
          );
        } catch { /* ignore */ }
        break; // Stop on first failure (preserve ordering)
      }
    }

    // Collect types of unprocessed events after the break
    for (const event of events.slice(flushed + (failedTypes.length ? 1 : 0))) {
      if (!failedTypes.includes(event.event_type as string)) {
        failedTypes.push(event.event_type as string);
      }
    }

    return { flushed, remaining: events.length - flushed, failedTypes };
  }

  async _dispatchQueuedEvent(type: string, data: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'stream_created':
        return this.syncStreamCreated(data.repoId as string, data as unknown as StreamCreatedData);
      case 'commit':
        return this.syncCommit(data.repoId as string, data.streamId as string, data as unknown as CommitData);
      case 'submit_review':
        return this.syncSubmitForReview(data.repoId as string, data.streamId as string);
      case 'review':
        return this.syncReview(data.repoId as string, data.streamId as string, data as unknown as ReviewData);
      case 'merge':
        return this.syncMergeCompleted(data.repoId as string, data.streamId as string, data as unknown as MergeCompletedData);
      case 'merge_requested':
        return this.requestMerge(data.repoId as string, data.streamId as string);
      case 'stabilize':
        return this.syncStabilization(data.repoId as string, data as unknown as StabilizationData);
      case 'promote':
        return this.syncPromotion(data.repoId as string, data as unknown as PromotionData);
      case 'stream_abandoned':
        return this.syncStreamAbandoned(data.repoId as string, data.streamId as string, data.reason as string);
      case 'council_proposal':
        return this.syncCouncilProposal(data.repoId as string, data.proposal as Record<string, unknown>);
      case 'council_vote':
        return this.syncCouncilVote(data.repoId as string, data.proposalId as string, data);
      case 'stage_progression':
        return this.syncStageProgression(data.repoId as string, data as unknown as StageProgressionData);
      case 'task_claim':
        return this.claimTask(data.repoId as string, data.taskId as string, data as { streamId?: string });
      case 'task_submission':
        return this.syncTaskSubmission(data.repoId as string, data.taskId as string, data.claimId as string, data as unknown as TaskSubmissionData);
      default:
        throw new Error(`Unknown queued event type: ${type}`);
    }
  }

  // ── Health ──────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this._get('/health');
      this.online = true;
      return true;
    } catch {
      this.online = false;
      return false;
    }
  }

  isOnline(): boolean {
    return this.online;
  }
}
