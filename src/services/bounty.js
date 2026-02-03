import { query } from '../config/database.js';

/**
 * Bounty Service
 * Handles issue bounties and budget management for GitSwarm repositories
 */
export class BountyService {
  constructor(db = null) {
    this.db = db;
    this.query = db?.query || query;
  }

  // ============================================================
  // Budget Management
  // ============================================================

  /**
   * Get or create budget for a repository
   */
  async getOrCreateBudget(repoId) {
    // Try to get existing budget
    let result = await this.query(`
      SELECT * FROM gitswarm_repo_budgets WHERE repo_id = $1
    `, [repoId]);

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    // Create new budget
    result = await this.query(`
      INSERT INTO gitswarm_repo_budgets (repo_id)
      VALUES ($1)
      RETURNING *
    `, [repoId]);

    return result.rows[0];
  }

  /**
   * Get budget for a repository
   */
  async getBudget(repoId) {
    const result = await this.query(`
      SELECT * FROM gitswarm_repo_budgets WHERE repo_id = $1
    `, [repoId]);

    return result.rows[0] || null;
  }

  /**
   * Add credits to repository budget
   */
  async depositCredits(repoId, amount, agentId, description = null) {
    if (amount <= 0) {
      throw new Error('Deposit amount must be positive');
    }

    const budget = await this.getOrCreateBudget(repoId);

    // Update budget
    const newBalance = budget.available_credits + amount;
    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        total_credits = total_credits + $1,
        available_credits = available_credits + $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [amount, repoId]);

    // Record transaction
    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, agent_id, description)
      VALUES ($1, $2, 'deposit', $3, $4, $5)
    `, [repoId, amount, newBalance, agentId, description]);

    return { success: true, new_balance: newBalance };
  }

  /**
   * Withdraw credits from repository budget
   */
  async withdrawCredits(repoId, amount, agentId, description = null) {
    if (amount <= 0) {
      throw new Error('Withdrawal amount must be positive');
    }

    const budget = await this.getBudget(repoId);
    if (!budget) {
      throw new Error('Budget not found');
    }

    if (budget.available_credits < amount) {
      throw new Error('Insufficient credits');
    }

    // Update budget
    const newBalance = budget.available_credits - amount;
    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        available_credits = available_credits - $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [amount, repoId]);

    // Record transaction
    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, agent_id, description)
      VALUES ($1, $2, 'withdrawal', $3, $4, $5)
    `, [repoId, -amount, newBalance, agentId, description]);

    return { success: true, new_balance: newBalance };
  }

  /**
   * Get budget transaction history
   */
  async getBudgetTransactions(repoId, limit = 50, offset = 0) {
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
  // Bounty Management
  // ============================================================

  /**
   * Create a bounty for an issue
   */
  async createBounty(repoId, data, creatorId) {
    const {
      github_issue_number,
      github_issue_url,
      title,
      description,
      amount,
      labels = [],
      difficulty,
      expires_in_days
    } = data;

    // Get budget
    const budget = await this.getOrCreateBudget(repoId);

    // Check limits
    if (amount > budget.max_bounty_per_issue) {
      throw new Error(`Bounty exceeds maximum of ${budget.max_bounty_per_issue} credits`);
    }
    if (amount < budget.min_bounty_amount) {
      throw new Error(`Bounty must be at least ${budget.min_bounty_amount} credits`);
    }

    // Check available credits
    if (budget.available_credits < amount) {
      throw new Error('Insufficient budget credits');
    }

    // Calculate expiry
    let expiresAt = null;
    if (expires_in_days) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expires_in_days);
    }

    // Create bounty
    const result = await this.query(`
      INSERT INTO gitswarm_bounties (
        repo_id, github_issue_number, github_issue_url, title, description,
        amount, labels, difficulty, expires_at, created_by, funded_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      RETURNING *
    `, [
      repoId, github_issue_number, github_issue_url, title, description,
      amount, labels, difficulty, expiresAt, creatorId
    ]);

    const bounty = result.rows[0];

    // Reserve credits from budget
    const newAvailable = budget.available_credits - amount;
    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        available_credits = available_credits - $1,
        reserved_credits = reserved_credits + $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [amount, repoId]);

    // Record transaction
    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, bounty_id, agent_id, description)
      VALUES ($1, $2, 'bounty_created', $3, $4, $5, $6)
    `, [repoId, -amount, newAvailable, bounty.id, creatorId, `Bounty created for issue #${github_issue_number}`]);

    return bounty;
  }

  /**
   * Get bounty by ID
   */
  async getBounty(bountyId) {
    const result = await this.query(`
      SELECT b.*, a.name as creator_name
      FROM gitswarm_bounties b
      LEFT JOIN agents a ON b.created_by = a.id
      WHERE b.id = $1
    `, [bountyId]);

    return result.rows[0] || null;
  }

  /**
   * Get bounty for an issue
   */
  async getBountyForIssue(repoId, issueNumber) {
    const result = await this.query(`
      SELECT b.*, a.name as creator_name
      FROM gitswarm_bounties b
      LEFT JOIN agents a ON b.created_by = a.id
      WHERE b.repo_id = $1 AND b.github_issue_number = $2
    `, [repoId, issueNumber]);

    return result.rows[0] || null;
  }

  /**
   * List bounties for a repository
   */
  async listBounties(repoId, options = {}) {
    const { status, limit = 50, offset = 0 } = options;

    let whereClause = 'b.repo_id = $1';
    const params = [repoId];

    if (status) {
      whereClause += ' AND b.status = $2';
      params.push(status);
    }

    params.push(limit, offset);

    const result = await this.query(`
      SELECT b.*, a.name as creator_name,
        (SELECT COUNT(*) FROM gitswarm_bounty_claims WHERE bounty_id = b.id AND status = 'active') as active_claims
      FROM gitswarm_bounties b
      LEFT JOIN agents a ON b.created_by = a.id
      WHERE ${whereClause}
      ORDER BY b.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return result.rows;
  }

  /**
   * Cancel a bounty
   */
  async cancelBounty(bountyId, agentId, reason = null) {
    const bounty = await this.getBounty(bountyId);
    if (!bounty) {
      throw new Error('Bounty not found');
    }

    if (bounty.status !== 'open') {
      throw new Error(`Cannot cancel bounty with status: ${bounty.status}`);
    }

    // Update bounty status
    await this.query(`
      UPDATE gitswarm_bounties SET status = 'cancelled'
      WHERE id = $1
    `, [bountyId]);

    // Return credits to budget
    const budget = await this.getBudget(bounty.repo_id);
    const newAvailable = budget.available_credits + bounty.amount;

    await this.query(`
      UPDATE gitswarm_repo_budgets SET
        available_credits = available_credits + $1,
        reserved_credits = reserved_credits - $1,
        updated_at = NOW()
      WHERE repo_id = $2
    `, [bounty.amount, bounty.repo_id]);

    // Record transaction
    await this.query(`
      INSERT INTO gitswarm_budget_transactions
        (repo_id, amount, type, balance_after, bounty_id, agent_id, description)
      VALUES ($1, $2, 'bounty_cancelled', $3, $4, $5, $6)
    `, [bounty.repo_id, bounty.amount, newAvailable, bountyId, agentId, reason || 'Bounty cancelled']);

    return { success: true };
  }

  // ============================================================
  // Bounty Claims
  // ============================================================

  /**
   * Claim a bounty
   */
  async claimBounty(bountyId, agentId) {
    const bounty = await this.getBounty(bountyId);
    if (!bounty) {
      throw new Error('Bounty not found');
    }

    if (bounty.status !== 'open') {
      throw new Error(`Cannot claim bounty with status: ${bounty.status}`);
    }

    // Check if already claimed by this agent
    const existing = await this.query(`
      SELECT id FROM gitswarm_bounty_claims
      WHERE bounty_id = $1 AND agent_id = $2 AND status = 'active'
    `, [bountyId, agentId]);

    if (existing.rows.length > 0) {
      throw new Error('You have already claimed this bounty');
    }

    // Create claim
    const result = await this.query(`
      INSERT INTO gitswarm_bounty_claims (bounty_id, agent_id)
      VALUES ($1, $2)
      RETURNING *
    `, [bountyId, agentId]);

    // Update bounty status if first claim
    await this.query(`
      UPDATE gitswarm_bounties SET status = 'claimed'
      WHERE id = $1 AND status = 'open'
    `, [bountyId]);

    return result.rows[0];
  }

  /**
   * Submit work for a bounty claim
   */
  async submitClaim(claimId, agentId, data) {
    const { patch_id, pr_url, notes } = data;

    // Verify ownership
    const claim = await this.query(`
      SELECT * FROM gitswarm_bounty_claims WHERE id = $1 AND agent_id = $2
    `, [claimId, agentId]);

    if (claim.rows.length === 0) {
      throw new Error('Claim not found or not owned by you');
    }

    if (claim.rows[0].status !== 'active') {
      throw new Error(`Cannot submit claim with status: ${claim.rows[0].status}`);
    }

    // Update claim
    const result = await this.query(`
      UPDATE gitswarm_bounty_claims SET
        status = 'submitted',
        patch_id = $1,
        pr_url = $2,
        submission_notes = $3,
        submitted_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [patch_id, pr_url, notes, claimId]);

    // Update bounty status
    await this.query(`
      UPDATE gitswarm_bounties SET status = 'submitted'
      WHERE id = $1
    `, [claim.rows[0].bounty_id]);

    return result.rows[0];
  }

  /**
   * Review and approve/reject a claim
   */
  async reviewClaim(claimId, reviewerId, decision, notes = null) {
    const claim = await this.query(`
      SELECT c.*, b.amount, b.repo_id FROM gitswarm_bounty_claims c
      JOIN gitswarm_bounties b ON c.bounty_id = b.id
      WHERE c.id = $1
    `, [claimId]);

    if (claim.rows.length === 0) {
      throw new Error('Claim not found');
    }

    const claimData = claim.rows[0];

    if (claimData.status !== 'submitted') {
      throw new Error(`Cannot review claim with status: ${claimData.status}`);
    }

    if (decision === 'approve') {
      // Approve and pay out
      await this.query(`
        UPDATE gitswarm_bounty_claims SET
          status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2,
          payout_amount = $3,
          paid_at = NOW()
        WHERE id = $4
      `, [reviewerId, notes, claimData.amount, claimId]);

      // Update bounty status
      await this.query(`
        UPDATE gitswarm_bounties SET status = 'completed', completed_at = NOW()
        WHERE id = $1
      `, [claimData.bounty_id]);

      // Remove from reserved credits
      await this.query(`
        UPDATE gitswarm_repo_budgets SET
          reserved_credits = reserved_credits - $1,
          updated_at = NOW()
        WHERE repo_id = $2
      `, [claimData.amount, claimData.repo_id]);

      // Award karma to the claimant
      await this.query(`
        UPDATE agents SET karma = karma + $1 WHERE id = $2
      `, [Math.floor(claimData.amount / 10), claimData.agent_id]);

      // Record transaction
      await this.query(`
        INSERT INTO gitswarm_budget_transactions
          (repo_id, amount, type, balance_after, bounty_id, agent_id, description)
        VALUES ($1, $2, 'bounty_paid', $3, $4, $5, $6)
      `, [
        claimData.repo_id, -claimData.amount,
        0, // Reserved credits, not available
        claimData.bounty_id, claimData.agent_id,
        `Bounty paid to claimant`
      ]);

      return { success: true, action: 'approved', amount_paid: claimData.amount };
    } else {
      // Reject
      await this.query(`
        UPDATE gitswarm_bounty_claims SET
          status = 'rejected',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2
        WHERE id = $3
      `, [reviewerId, notes, claimId]);

      // Reopen bounty for other claims
      await this.query(`
        UPDATE gitswarm_bounties SET status = 'open'
        WHERE id = $1
      `, [claimData.bounty_id]);

      return { success: true, action: 'rejected' };
    }
  }

  /**
   * Abandon a claim
   */
  async abandonClaim(claimId, agentId) {
    const claim = await this.query(`
      SELECT * FROM gitswarm_bounty_claims WHERE id = $1 AND agent_id = $2
    `, [claimId, agentId]);

    if (claim.rows.length === 0) {
      throw new Error('Claim not found or not owned by you');
    }

    if (!['active', 'submitted'].includes(claim.rows[0].status)) {
      throw new Error('Cannot abandon claim with current status');
    }

    await this.query(`
      UPDATE gitswarm_bounty_claims SET status = 'abandoned'
      WHERE id = $1
    `, [claimId]);

    // Check if there are other active claims
    const otherClaims = await this.query(`
      SELECT COUNT(*) as count FROM gitswarm_bounty_claims
      WHERE bounty_id = $1 AND status = 'active' AND id != $2
    `, [claim.rows[0].bounty_id, claimId]);

    if (parseInt(otherClaims.rows[0].count) === 0) {
      // No other claims, reopen bounty
      await this.query(`
        UPDATE gitswarm_bounties SET status = 'open'
        WHERE id = $1
      `, [claim.rows[0].bounty_id]);
    }

    return { success: true };
  }

  /**
   * List claims for a bounty
   */
  async listClaims(bountyId) {
    const result = await this.query(`
      SELECT c.*, a.name as agent_name, a.karma, a.avatar_url
      FROM gitswarm_bounty_claims c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.bounty_id = $1
      ORDER BY c.claimed_at DESC
    `, [bountyId]);

    return result.rows;
  }

  /**
   * Get claims by agent
   */
  async getAgentClaims(agentId, status = null) {
    let whereClause = 'c.agent_id = $1';
    const params = [agentId];

    if (status) {
      whereClause += ' AND c.status = $2';
      params.push(status);
    }

    const result = await this.query(`
      SELECT c.*, b.title as bounty_title, b.amount, b.repo_id,
        r.github_full_name as repo_name
      FROM gitswarm_bounty_claims c
      JOIN gitswarm_bounties b ON c.bounty_id = b.id
      JOIN gitswarm_repos r ON b.repo_id = r.id
      WHERE ${whereClause}
      ORDER BY c.claimed_at DESC
    `, params);

    return result.rows;
  }

  /**
   * Check and expire old bounties
   */
  async expireOldBounties() {
    const expired = await this.query(`
      UPDATE gitswarm_bounties SET status = 'expired'
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < NOW()
      RETURNING *
    `);

    // Return credits for each expired bounty
    for (const bounty of expired.rows) {
      const budget = await this.getBudget(bounty.repo_id);
      const newAvailable = budget.available_credits + bounty.amount;

      await this.query(`
        UPDATE gitswarm_repo_budgets SET
          available_credits = available_credits + $1,
          reserved_credits = reserved_credits - $1,
          updated_at = NOW()
        WHERE repo_id = $2
      `, [bounty.amount, bounty.repo_id]);

      await this.query(`
        INSERT INTO gitswarm_budget_transactions
          (repo_id, amount, type, balance_after, bounty_id, description)
        VALUES ($1, $2, 'bounty_expired', $3, $4, $5)
      `, [bounty.repo_id, bounty.amount, newAvailable, bounty.id, 'Bounty expired']);
    }

    return { expired_count: expired.rows.length };
  }
}

// Export singleton instance
export const bountyService = new BountyService();
