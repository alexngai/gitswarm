/**
 * Task distribution and management for local federation.
 *
 * Replaces the web app's BountyService with a simpler, local-first
 * task system suitable for sandboxed multi-agent coordination.
 */
import type { SqliteStore } from '../store/sqlite.js';

export interface TaskCreateData {
  title: string;
  description?: string;
  priority?: string;
  amount?: number;
  labels?: string[];
  difficulty?: string | null;
  expires_in_days?: number | null;
}

export interface TaskListOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface TaskSubmitData {
  stream_id?: string | null;
  notes?: string;
}

export interface TaskReviewResult {
  action: string;
  amount?: number;
}

export class TaskService {
  private query: SqliteStore['query'];

  constructor(store: SqliteStore) {
    this.query = store.query.bind(store);
  }

  /** Create a new task in a repo. */
  async create(repoId: string, data: TaskCreateData, creatorId: string | null | undefined): Promise<Record<string, unknown>> {
    const {
      title,
      description = '',
      priority = 'medium',
      amount = 0,
      labels = [],
      difficulty = null,
      expires_in_days = null,
    } = data;

    let expiresAt: string | null = null;
    if (expires_in_days) {
      const d = new Date();
      d.setDate(d.getDate() + expires_in_days);
      expiresAt = d.toISOString();
    }

    const result = await this.query(
      `INSERT INTO tasks (repo_id, title, description, priority, amount, labels, difficulty, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [repoId, title, description, priority, amount, JSON.stringify(labels), difficulty, expiresAt, creatorId]
    );

    return result.rows[0];
  }

  /** List tasks for a repo, optionally filtered by status. */
  async list(repoId: string, options: TaskListOptions = {}): Promise<Record<string, unknown>[]> {
    const { status, limit = 50, offset = 0 } = options;
    let sql = `SELECT t.*, a.name as creator_name,
                 (SELECT COUNT(*) FROM task_claims WHERE task_id = t.id AND status = 'active') as active_claims
               FROM tasks t
               LEFT JOIN agents a ON t.created_by = a.id
               WHERE t.repo_id = ?`;
    const params: unknown[] = [repoId];

    if (status) {
      sql += ` AND t.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY
               CASE t.priority
                 WHEN 'critical' THEN 0
                 WHEN 'high'     THEN 1
                 WHEN 'medium'   THEN 2
                 WHEN 'low'      THEN 3
               END,
               t.created_at DESC
             LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return (await this.query(sql, params)).rows;
  }

  /** Get a single task by ID. */
  async get(taskId: string): Promise<Record<string, unknown> | null> {
    const r = await this.query(
      `SELECT t.*, a.name as creator_name FROM tasks t
       LEFT JOIN agents a ON t.created_by = a.id
       WHERE t.id = ?`,
      [taskId]
    );
    return r.rows[0] || null;
  }

  /** Claim a task, optionally linking it to a git-cascade stream. */
  async claim(taskId: string, agentId: string, streamId: string | null = null): Promise<Record<string, unknown>> {
    const task = await this.get(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'open') throw new Error(`Cannot claim task with status: ${task.status}`);
    // BUG-2 fix: Prevent self-claim (ported from web bounties route)
    if (task.created_by === agentId) throw new Error('Cannot claim your own task');

    const existing = await this.query(
      `SELECT id FROM task_claims WHERE task_id = ? AND agent_id = ? AND status = 'active'`,
      [taskId, agentId]
    );
    if (existing.rows.length > 0) throw new Error('You have already claimed this task');

    const result = await this.query(
      `INSERT INTO task_claims (task_id, agent_id, stream_id) VALUES (?, ?, ?) RETURNING *`,
      [taskId, agentId, streamId]
    );

    await this.query(
      `UPDATE tasks SET status = 'claimed', updated_at = datetime('now') WHERE id = ? AND status = 'open'`,
      [taskId]
    );

    return result.rows[0];
  }

  /** Submit work for a claimed task. */
  async submit(claimId: string, agentId: string, data: TaskSubmitData): Promise<Record<string, unknown>> {
    const { stream_id = null, notes = '' } = data;
    const claim = await this.query(
      `SELECT * FROM task_claims WHERE id = ? AND agent_id = ?`, [claimId, agentId]
    );
    if (claim.rows.length === 0) throw new Error('Claim not found');
    if (claim.rows[0].status !== 'active') throw new Error('Claim is not active');

    const result = await this.query(
      `UPDATE task_claims SET status = 'submitted', stream_id = COALESCE(?, stream_id), submission_notes = ?, submitted_at = datetime('now')
       WHERE id = ? RETURNING *`,
      [stream_id, notes, claimId]
    );

    await this.query(
      `UPDATE tasks SET status = 'submitted', updated_at = datetime('now') WHERE id = ?`,
      [claim.rows[0].task_id]
    );

    return result.rows[0];
  }

  /** Approve or reject a submission. */
  async review(claimId: string, reviewerId: string, decision: string, notes: string | null = null): Promise<TaskReviewResult> {
    const claim = await this.query(
      `SELECT c.*, t.amount, t.repo_id FROM task_claims c JOIN tasks t ON c.task_id = t.id WHERE c.id = ?`,
      [claimId]
    );
    if (claim.rows.length === 0) throw new Error('Claim not found');
    const c = claim.rows[0];
    if (c.status !== 'submitted') throw new Error('Claim is not submitted');

    if (decision === 'approve') {
      await this.query(
        `UPDATE task_claims SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ?
         WHERE id = ?`,
        [reviewerId, notes, claimId]
      );
      await this.query(
        `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [c.task_id]
      );
      // Award karma
      // BUG-12 fix: Ensure minimum 1 karma for any positive amount
      if ((c.amount as number) > 0) {
        await this.query(
          `UPDATE agents SET karma = karma + ? WHERE id = ?`,
          [Math.max(1, Math.floor((c.amount as number) / 10)), c.agent_id]
        );
      }
      return { action: 'approved', amount: c.amount as number };
    }

    // Reject
    await this.query(
      `UPDATE task_claims SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ?
       WHERE id = ?`,
      [reviewerId, notes, claimId]
    );
    await this.query(
      `UPDATE tasks SET status = 'open', updated_at = datetime('now') WHERE id = ?`,
      [c.task_id]
    );
    return { action: 'rejected' };
  }

  /** Abandon a claim. */
  async abandon(claimId: string, agentId: string): Promise<{ success: boolean }> {
    const claim = await this.query(
      `SELECT * FROM task_claims WHERE id = ? AND agent_id = ?`, [claimId, agentId]
    );
    if (claim.rows.length === 0) throw new Error('Claim not found');

    await this.query(`UPDATE task_claims SET status = 'abandoned' WHERE id = ?`, [claimId]);

    const other = await this.query(
      `SELECT COUNT(*) as c FROM task_claims WHERE task_id = ? AND status = 'active' AND id != ?`,
      [claim.rows[0].task_id, claimId]
    );
    if (parseInt(other.rows[0].c as string) === 0) {
      await this.query(
        `UPDATE tasks SET status = 'open', updated_at = datetime('now') WHERE id = ?`,
        [claim.rows[0].task_id]
      );
    }
    return { success: true };
  }

  /** Look up a claim by its linked stream. */
  async getClaimByStream(streamId: string): Promise<Record<string, unknown> | null> {
    const r = await this.query(
      `SELECT c.*, t.title as task_title, t.priority, t.repo_id
       FROM task_claims c
       JOIN tasks t ON c.task_id = t.id
       WHERE c.stream_id = ? AND c.status IN ('active', 'submitted')`,
      [streamId]
    );
    return r.rows[0] || null;
  }

  /** Link an existing claim to a stream (when workspace is created after claim). */
  async linkClaimToStream(claimId: string, streamId: string): Promise<void> {
    await this.query(
      `UPDATE task_claims SET stream_id = ? WHERE id = ?`,
      [streamId, claimId]
    );
  }
}
