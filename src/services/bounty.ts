import { query } from '../config/database.js';

interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

interface TaskData {
  title: string;
  description?: string;
  priority?: string;
  amount?: number;
  labels?: string[];
  difficulty?: string | null;
  expires_in_days?: number | null;
  github_issue_number?: number | null;
  github_issue_url?: string | null;
}

interface TaskListOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

interface SubmitClaimData {
  stream_id?: string | null;
  notes?: string;
}

/**
 * Task & Bounty Service
 * Unified task management with optional bounty budgets for GitSwarm repositories.
 * Tasks replace the old bounty-only model and integrate with git-cascade streams.
 */
export class BountyService {
  private db: DbClient | null;
  private query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;

  constructor(db: DbClient | null = null) {
    this.db = db;
    this.query = db?.query || query;
  }

  // ============================================================
  // Budget Management
  // ============================================================

  async getOrCreateBudget(repoId: string): Promise<Record<string, any>> {
    let result = await this.query(`
      SELECT * FROM gitswarm_repo_budgets WHERE repo_id = $1
    `, [repoId]);

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    result = await this.query(`
      INSERT INTO gitswarm_repo_budgets (repo_id)
      VALUES ($1)
      RETURNING *
    `, [repoId]);

    return result.rows[0];
  }

  async getBudget(repoId: string): Promise<Record<string, any> | null> {
    const result = await this.query(`
      SELECT * FROM gitswarm_repo_budgets WHERE repo_id = $1
    `, [repoId]);
    return result.rows[0] || null;
  }

  async depositCredits(repoId: string, amount: number, agentId: string, description: string | null = null): Promise<{ success: boolean; new_balance: number }> {
    if (amount <= 0) throw new Error('Deposit amount must be positive');

    const budget = await this.getOrCreateBudget(repoId);
    const newBalance = budget.available_credits + amount;

    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        total_credits = total_credits + $1,
        available_credits = available_credits + $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [amount, repoId]);

    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, agent_id, description)
      VALUES ($1, $2, 'deposit', $3, $4, $5)
    `, [repoId, amount, newBalance, agentId, description]);

    return { success: true, new_balance: newBalance };
  }

  async withdrawCredits(repoId: string, amount: number, agentId: string, description: string | null = null): Promise<{ success: boolean; new_balance: number }> {
    if (amount <= 0) throw new Error('Withdrawal amount must be positive');

    const budget = await this.getBudget(repoId);
    if (!budget) throw new Error('Budget not found');
    if (budget.available_credits < amount) throw new Error('Insufficient credits');

    const newBalance = budget.available_credits - amount;
    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        available_credits = available_credits - $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [amount, repoId]);

    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, agent_id, description)
      VALUES ($1, $2, 'withdrawal', $3, $4, $5)
    `, [repoId, -amount, newBalance, agentId, description]);

    return { success: true, new_balance: newBalance };
  }

  async getBudgetTransactions(repoId: string, limit: number = 50, offset: number = 0): Promise<Record<string, any>[]> {
    const result = await this.query(`
      SELECT t.*, a.name as agent_name
      FROM gitswarm_budget_transactions t
      LEFT JOIN agents a ON t.agent_id = a.id
      WHERE t.repo_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3
    `, [repoId, limit, offset]);
    return result.rows;
  }

  // ============================================================
  // Task Management (replaces bounties)
  // ============================================================

  /**
   * Create a task (optionally with a bounty amount)
   */
  async createTask(repoId: string, data: TaskData, creatorId: string): Promise<Record<string, any>> {
    const {
      title,
      description = '',
      priority = 'medium',
      amount = 0,
      labels = [],
      difficulty = null,
      expires_in_days = null,
      github_issue_number = null,
      github_issue_url = null,
    } = data;

    // If amount > 0, this is a bounty task — check budget
    let budget = null;
    if (amount > 0) {
      budget = await this.getOrCreateBudget(repoId);
      if (amount > budget.max_bounty_per_issue) {
        throw new Error(`Amount exceeds maximum of ${budget.max_bounty_per_issue} credits`);
      }
      if (amount < budget.min_bounty_amount) {
        throw new Error(`Amount must be at least ${budget.min_bounty_amount} credits`);
      }
      if (budget.available_credits < amount) {
        throw new Error('Insufficient budget credits');
      }
    }

    let expiresAt = null;
    if (expires_in_days) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expires_in_days);
    }

    const result = await this.query(`
      INSERT INTO gitswarm_tasks (
        repo_id, title, description, priority, amount, labels,
        difficulty, expires_at, created_by,
        github_issue_number, github_issue_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      repoId, title, description, priority, amount,
      JSON.stringify(labels), difficulty, expiresAt, creatorId,
      github_issue_number, github_issue_url,
    ]);

    const task = result.rows[0];

    // Reserve bounty credits if applicable (reuse budget from above)
    if (amount > 0 && budget) {
      const newAvailable = budget.available_credits - amount;

      await this.query(`
        UPDATE gitswarm_repo_budgets SET
          available_credits = available_credits - $1,
          reserved_credits = reserved_credits + $1,
          updated_at = NOW()
        WHERE repo_id = $2
      `, [amount, repoId]);

      await this.query(`
        INSERT INTO gitswarm_budget_transactions
          (repo_id, amount, type, balance_after, task_id, agent_id, description)
        VALUES ($1, $2, 'bounty_reserve', $3, $4, $5, $6)
      `, [repoId, -amount, newAvailable, task.id, creatorId,
          `Bounty reserved for task: ${title}`]);
    }

    return task;
  }

  /**
   * Get task by ID
   */
  async getTask(taskId: string): Promise<Record<string, any> | null> {
    const result = await this.query(`
      SELECT t.*, a.name as creator_name
      FROM gitswarm_tasks t
      LEFT JOIN agents a ON t.created_by = a.id
      WHERE t.id = $1
    `, [taskId]);
    return result.rows[0] || null;
  }

  /**
   * List tasks for a repository
   */
  async listTasks(repoId: string, options: TaskListOptions = {}): Promise<Record<string, any>[]> {
    const { status, limit = 50, offset = 0 } = options;

    let whereClause = 't.repo_id = $1';
    const params: any[] = [repoId];

    if (status) {
      whereClause += ' AND t.status = $2';
      params.push(status);
    }

    params.push(limit, offset);

    const result = await this.query(`
      SELECT t.*, a.name as creator_name,
        (SELECT COUNT(*) FROM gitswarm_task_claims WHERE task_id = t.id AND status = 'active') as active_claims
      FROM gitswarm_tasks t
      LEFT JOIN agents a ON t.created_by = a.id
      WHERE ${whereClause}
      ORDER BY
        CASE t.priority
          WHEN 'critical' THEN 0
          WHEN 'high'     THEN 1
          WHEN 'medium'   THEN 2
          WHEN 'low'      THEN 3
        END,
        t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return result.rows;
  }

  /**
   * Cancel a task and release reserved credits
   */
  async cancelTask(taskId: string, agentId: string, reason: string | null = null): Promise<{ success: boolean }> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'open') throw new Error(`Cannot cancel task with status: ${task.status}`);

    await this.query(`
      UPDATE gitswarm_tasks SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
    `, [taskId]);

    // Return credits if bounty
    if (task.amount > 0) {
      const budget = await this.getBudget(task.repo_id);
      const newAvailable = budget.available_credits + task.amount;

      await this.query(`
        UPDATE gitswarm_repo_budgets SET
          available_credits = available_credits + $1,
          reserved_credits = reserved_credits - $1,
          updated_at = NOW()
        WHERE repo_id = $2
      `, [task.amount, task.repo_id]);

      await this.query(`
        INSERT INTO gitswarm_budget_transactions
          (repo_id, amount, type, balance_after, task_id, agent_id, description)
        VALUES ($1, $2, 'bounty_release', $3, $4, $5, $6)
      `, [task.repo_id, task.amount, newAvailable, taskId, agentId,
          reason || 'Task cancelled']);
    }

    return { success: true };
  }

  // ============================================================
  // Task Claims (linked to streams)
  // ============================================================

  /**
   * Claim a task, optionally linking to a stream
   */
  async claimTask(taskId: string, agentId: string, streamId: string | null = null): Promise<Record<string, any>> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'open') throw new Error(`Cannot claim task with status: ${task.status}`);

    const existing = await this.query(`
      SELECT id FROM gitswarm_task_claims
      WHERE task_id = $1 AND agent_id = $2 AND status = 'active'
    `, [taskId, agentId]);

    if (existing.rows.length > 0) throw new Error('You have already claimed this task');

    const result = await this.query(`
      INSERT INTO gitswarm_task_claims (task_id, agent_id, stream_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [taskId, agentId, streamId]);

    await this.query(`
      UPDATE gitswarm_tasks SET status = 'claimed', updated_at = NOW()
      WHERE id = $1 AND status = 'open'
    `, [taskId]);

    return result.rows[0];
  }

  /**
   * Submit work for a task claim (with stream linkage)
   */
  async submitClaim(claimId: string, agentId: string, data: SubmitClaimData): Promise<Record<string, any>> {
    const { stream_id = null, notes = '' } = data;

    const claim = await this.query(`
      SELECT * FROM gitswarm_task_claims WHERE id = $1 AND agent_id = $2
    `, [claimId, agentId]);

    if (claim.rows.length === 0) throw new Error('Claim not found or not owned by you');
    if (claim.rows[0].status !== 'active') {
      throw new Error(`Cannot submit claim with status: ${claim.rows[0].status}`);
    }

    const result = await this.query(`
      UPDATE gitswarm_task_claims SET
        status = 'submitted',
        stream_id = COALESCE($1, stream_id),
        submission_notes = $2,
        submitted_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [stream_id, notes, claimId]);

    await this.query(`
      UPDATE gitswarm_tasks SET status = 'submitted', updated_at = NOW()
      WHERE id = $1
    `, [claim.rows[0].task_id]);

    return result.rows[0];
  }

  /**
   * Review and approve/reject a claim
   */
  async reviewClaim(claimId: string, reviewerId: string, decision: string, notes: string | null = null): Promise<{ success: boolean; action: string; amount_paid?: number }> {
    const claim = await this.query(`
      SELECT c.*, t.amount, t.repo_id FROM gitswarm_task_claims c
      JOIN gitswarm_tasks t ON c.task_id = t.id
      WHERE c.id = $1
    `, [claimId]);

    if (claim.rows.length === 0) throw new Error('Claim not found');
    const claimData = claim.rows[0];
    if (claimData.status !== 'submitted') {
      throw new Error(`Cannot review claim with status: ${claimData.status}`);
    }

    if (decision === 'approve') {
      await this.query(`
        UPDATE gitswarm_task_claims SET
          status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2,
          payout_amount = $3
        WHERE id = $4
      `, [reviewerId, notes, claimData.amount, claimId]);

      await this.query(`
        UPDATE gitswarm_tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [claimData.task_id]);

      // Release reserved credits
      if (claimData.amount > 0) {
        await this.query(`
          UPDATE gitswarm_repo_budgets SET
            reserved_credits = reserved_credits - $1,
            updated_at = NOW()
          WHERE repo_id = $2
        `, [claimData.amount, claimData.repo_id]);

        // Award karma
        await this.query(`
          UPDATE agents SET karma = karma + $1 WHERE id = $2
        `, [Math.floor(claimData.amount / 10), claimData.agent_id]);

        await this.query(`
          INSERT INTO gitswarm_budget_transactions
            (repo_id, amount, type, balance_after, task_id, agent_id, description)
          VALUES ($1, $2, 'payout', 0, $3, $4, 'Task bounty paid')
        `, [claimData.repo_id, -claimData.amount, claimData.task_id, claimData.agent_id]);
      }

      return { success: true, action: 'approved', amount_paid: claimData.amount };
    } else {
      // Reject
      await this.query(`
        UPDATE gitswarm_task_claims SET
          status = 'rejected',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2
        WHERE id = $3
      `, [reviewerId, notes, claimId]);

      await this.query(`
        UPDATE gitswarm_tasks SET status = 'open', updated_at = NOW()
        WHERE id = $1
      `, [claimData.task_id]);

      return { success: true, action: 'rejected' };
    }
  }

  /**
   * Abandon a claim
   */
  async abandonClaim(claimId: string, agentId: string): Promise<{ success: boolean }> {
    const claim = await this.query(`
      SELECT * FROM gitswarm_task_claims WHERE id = $1 AND agent_id = $2
    `, [claimId, agentId]);

    if (claim.rows.length === 0) throw new Error('Claim not found or not owned by you');
    if (!['active', 'submitted'].includes(claim.rows[0].status)) {
      throw new Error('Cannot abandon claim with current status');
    }

    await this.query(`
      UPDATE gitswarm_task_claims SET status = 'abandoned' WHERE id = $1
    `, [claimId]);

    const otherClaims = await this.query(`
      SELECT COUNT(*) as count FROM gitswarm_task_claims
      WHERE task_id = $1 AND status = 'active' AND id != $2
    `, [claim.rows[0].task_id, claimId]);

    if (parseInt(otherClaims.rows[0].count) === 0) {
      await this.query(`
        UPDATE gitswarm_tasks SET status = 'open', updated_at = NOW()
        WHERE id = $1
      `, [claim.rows[0].task_id]);
    }

    return { success: true };
  }

  /**
   * List claims for a task
   */
  async listClaims(taskId: string): Promise<Record<string, any>[]> {
    const result = await this.query(`
      SELECT c.*, a.name as agent_name, a.karma, a.avatar_url,
        s.name as stream_name, s.status as stream_status
      FROM gitswarm_task_claims c
      JOIN agents a ON c.agent_id = a.id
      LEFT JOIN gitswarm_streams s ON c.stream_id = s.id
      WHERE c.task_id = $1
      ORDER BY c.claimed_at DESC
    `, [taskId]);
    return result.rows;
  }

  /**
   * Get claims by agent
   */
  async getAgentClaims(agentId: string, status: string | null = null): Promise<Record<string, any>[]> {
    let whereClause = 'c.agent_id = $1';
    const params = [agentId];

    if (status) {
      whereClause += ' AND c.status = $2';
      params.push(status);
    }

    const result = await this.query(`
      SELECT c.*, t.title as task_title, t.amount, t.repo_id,
        r.github_full_name as repo_name, r.name as repo_local_name,
        s.name as stream_name
      FROM gitswarm_task_claims c
      JOIN gitswarm_tasks t ON c.task_id = t.id
      JOIN gitswarm_repos r ON t.repo_id = r.id
      LEFT JOIN gitswarm_streams s ON c.stream_id = s.id
      WHERE ${whereClause}
      ORDER BY c.claimed_at DESC
    `, params);

    return result.rows;
  }

  /**
   * Look up a claim by its linked stream
   */
  async getClaimByStream(streamId: string): Promise<Record<string, any> | null> {
    const r = await this.query(`
      SELECT c.*, t.title as task_title, t.priority, t.repo_id
      FROM gitswarm_task_claims c
      JOIN gitswarm_tasks t ON c.task_id = t.id
      WHERE c.stream_id = $1 AND c.status IN ('active', 'submitted')
    `, [streamId]);
    return r.rows[0] || null;
  }

  /**
   * Link an existing claim to a stream
   */
  async linkClaimToStream(claimId: string, streamId: string): Promise<void> {
    await this.query(`
      UPDATE gitswarm_task_claims SET stream_id = $1 WHERE id = $2
    `, [streamId, claimId]);
  }

  /**
   * Expire old tasks
   */
  async expireOldTasks(): Promise<{ expired_count: number }> {
    const expired = await this.query(`
      UPDATE gitswarm_tasks SET status = 'cancelled', updated_at = NOW()
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < NOW()
      RETURNING *
    `);

    for (const task of expired.rows) {
      if (task.amount > 0) {
        const budget = await this.getBudget(task.repo_id);
        if (budget) {
          const newAvailable = budget.available_credits + task.amount;
          await this.query(`
            UPDATE gitswarm_repo_budgets SET
              available_credits = available_credits + $1,
              reserved_credits = reserved_credits - $1,
              updated_at = NOW()
            WHERE repo_id = $2
          `, [task.amount, task.repo_id]);

          await this.query(`
            INSERT INTO gitswarm_budget_transactions
              (repo_id, amount, type, balance_after, task_id, description)
            VALUES ($1, $2, 'bounty_release', $3, $4, 'Task expired')
          `, [task.repo_id, task.amount, newAvailable, task.id]);
        }
      }
    }

    return { expired_count: expired.rows.length };
  }

  // ============================================================
  // Backward-compatible aliases
  // ============================================================

  createBounty(repoId: string, data: TaskData, creatorId: string): Promise<Record<string, any>> {
    return this.createTask(repoId, data, creatorId);
  }

  getBounty(taskId: string): Promise<Record<string, any> | null> {
    return this.getTask(taskId);
  }

  listBounties(repoId: string, options?: TaskListOptions): Promise<Record<string, any>[]> {
    return this.listTasks(repoId, options);
  }

  cancelBounty(taskId: string, agentId: string, reason?: string): Promise<{ success: boolean }> {
    return this.cancelTask(taskId, agentId, reason);
  }

  claimBounty(taskId: string, agentId: string): Promise<Record<string, any>> {
    return this.claimTask(taskId, agentId);
  }

  expireOldBounties(): Promise<{ expired_count: number }> {
    return this.expireOldTasks();
  }
}

// Export singleton instance
export const bountyService = new BountyService();
