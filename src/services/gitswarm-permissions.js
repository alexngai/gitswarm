import { query } from '../config/database.js';

/**
 * GitSwarm Permission Service
 * Handles all permission resolution for GitSwarm repositories
 */
export class GitSwarmPermissionService {
  constructor(db = null) {
    this.db = db;
    this.query = db?.query || query;
  }

  /**
   * Resolve effective permissions for an agent on a repository
   * @param {string} agentId - Agent UUID
   * @param {string} repoId - Repository UUID
   * @returns {Promise<{level: string, source: string, ...}>}
   */
  async resolvePermissions(agentId, repoId) {
    // 1. Check explicit agent access
    const explicit = await this.query(`
      SELECT access_level, expires_at
      FROM gitswarm_repo_access
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (explicit.rows.length > 0) {
      const { access_level, expires_at } = explicit.rows[0];

      // Check expiry
      if (expires_at && new Date(expires_at) < new Date()) {
        // Access expired, remove it
        await this.query(`
          DELETE FROM gitswarm_repo_access
          WHERE repo_id = $1 AND agent_id = $2
        `, [repoId, agentId]);
      } else {
        return { level: access_level, source: 'explicit' };
      }
    }

    // 2. Check maintainer status
    const maintainer = await this.query(`
      SELECT role FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length > 0) {
      const level = maintainer.rows[0].role === 'owner' ? 'admin' : 'maintain';
      return { level, source: 'maintainer', role: maintainer.rows[0].role };
    }

    // 3. Get repo and org settings
    const repo = await this.query(`
      SELECT
        r.agent_access,
        r.min_karma,
        r.is_private,
        r.ownership_model,
        o.default_agent_access,
        o.default_min_karma,
        o.is_platform_org
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { level: 'none', source: 'not_found' };
    }

    const {
      agent_access,
      min_karma,
      is_private,
      ownership_model,
      default_agent_access,
      default_min_karma,
      is_platform_org
    } = repo.rows[0];

    // 4. Get agent karma
    const agent = await this.query(`SELECT karma FROM agents WHERE id = $1`, [agentId]);
    const agentKarma = agent.rows[0]?.karma || 0;

    // 5. Resolve effective access mode
    const accessMode = agent_access || default_agent_access || 'none';
    const karmaThreshold = min_karma ?? default_min_karma ?? 0;

    // 6. Apply access mode
    switch (accessMode) {
      case 'public':
        return { level: 'write', source: 'public' };

      case 'karma_threshold':
        if (agentKarma >= karmaThreshold) {
          return { level: 'write', source: 'karma', threshold: karmaThreshold, karma: agentKarma };
        }
        // Below threshold: read-only for public repos, none for private
        if (is_private) {
          return { level: 'none', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };
        }
        return { level: 'read', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };

      case 'allowlist':
        // Already checked explicit access in step 1
        return { level: 'none', source: 'not_allowlisted' };

      default: // 'none'
        if (is_platform_org && !is_private) {
          // Platform org public repos: anyone can read
          return { level: 'read', source: 'platform_public' };
        }
        return { level: 'none', source: 'private' };
    }
  }

  /**
   * Check if agent can perform a specific action
   * @param {string} agentId - Agent UUID
   * @param {string} repoId - Repository UUID
   * @param {string} action - Action to check (read, write, merge, settings, delete)
   * @returns {Promise<{allowed: boolean, permissions: object}>}
   */
  async canPerform(agentId, repoId, action) {
    const permissions = await this.resolvePermissions(agentId, repoId);

    const actionLevels = {
      'read': ['read', 'write', 'maintain', 'admin'],
      'write': ['write', 'maintain', 'admin'],
      'merge': ['maintain', 'admin'],
      'settings': ['admin'],
      'delete': ['admin']
    };

    const allowedLevels = actionLevels[action] || [];
    return {
      allowed: allowedLevels.includes(permissions.level),
      permissions
    };
  }

  /**
   * Check branch-specific permissions
   * @param {string} agentId - Agent UUID
   * @param {string} repoId - Repository UUID
   * @param {string} branch - Branch name
   * @returns {Promise<{allowed: boolean, reason: string, rule?: object, permissions?: object}>}
   */
  async canPushToBranch(agentId, repoId, branch) {
    const permissions = await this.resolvePermissions(agentId, repoId);

    if (permissions.level === 'none' || permissions.level === 'read') {
      return { allowed: false, reason: 'insufficient_permissions', permissions };
    }

    // Get matching branch rule
    const rules = await this.query(`
      SELECT * FROM gitswarm_branch_rules
      WHERE repo_id = $1
      ORDER BY priority DESC, LENGTH(branch_pattern) DESC
    `, [repoId]);

    // Find matching rule
    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        switch (rule.direct_push) {
          case 'none':
            return { allowed: false, reason: 'branch_protected', rule };
          case 'maintainers':
            const allowed = permissions.level === 'maintain' || permissions.level === 'admin';
            return { allowed, reason: allowed ? 'maintainer' : 'maintainers_only', rule };
          case 'all':
            return { allowed: true, reason: 'allowed', rule };
        }
      }
    }

    // No matching rule, use default behavior (allow if has write access)
    return { allowed: true, reason: 'no_branch_rule', permissions };
  }

  /**
   * Check if consensus is reached for merging a stream
   * @param {string} streamId - Stream ID (git-cascade stream)
   * @param {string} repoId - Repository UUID
   * @returns {Promise<{reached: boolean, reason: string, ...}>}
   */
  async checkConsensus(streamId, repoId) {
    // Get repo consensus settings
    const repo = await this.query(`
      SELECT consensus_threshold, min_reviews, ownership_model, merge_mode, human_review_weight
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { reached: false, reason: 'repo_not_found' };
    }

    const { consensus_threshold, min_reviews, ownership_model, merge_mode, human_review_weight } = repo.rows[0];

    // In swarm mode, consensus is automatic
    if (merge_mode === 'swarm') {
      return { reached: true, reason: 'swarm_mode' };
    }

    // Get stream reviews
    const reviews = await this.query(`
      SELECT
        sr.verdict,
        sr.tested,
        sr.is_human,
        a.karma,
        CASE WHEN m.agent_id IS NOT NULL THEN true ELSE false END as is_maintainer
      FROM gitswarm_stream_reviews sr
      LEFT JOIN agents a ON sr.reviewer_id = a.id
      LEFT JOIN gitswarm_maintainers m ON m.repo_id = $2 AND m.agent_id = sr.reviewer_id
      WHERE sr.stream_id = $1
    `, [streamId, repoId]);

    const approvals = reviews.rows.filter(r => r.verdict === 'approve');
    const rejections = reviews.rows.filter(r => r.verdict === 'reject' || r.verdict === 'request_changes');

    // Check minimum reviews
    if (reviews.rows.length < min_reviews) {
      return {
        reached: false,
        reason: 'insufficient_reviews',
        current: reviews.rows.length,
        required: min_reviews
      };
    }

    // Calculate consensus based on ownership model
    if (ownership_model === 'solo') {
      // Solo: owner approval required
      const ownerApproval = approvals.some(r => r.is_maintainer);
      return {
        reached: ownerApproval,
        reason: ownerApproval ? 'owner_approved' : 'awaiting_owner',
        approvals: approvals.length,
        rejections: rejections.length
      };
    }

    if (ownership_model === 'guild') {
      // Guild: maintainer consensus
      const maintainerApprovals = approvals.filter(r => r.is_maintainer).length;
      const maintainerRejections = rejections.filter(r => r.is_maintainer).length;
      const maintainerTotal = maintainerApprovals + maintainerRejections;

      if (maintainerTotal === 0) {
        return { reached: false, reason: 'no_maintainer_reviews' };
      }

      const ratio = maintainerApprovals / maintainerTotal;
      return {
        reached: ratio >= consensus_threshold,
        reason: ratio >= consensus_threshold ? 'consensus_reached' : 'below_threshold',
        ratio: Math.round(ratio * 100) / 100,
        threshold: consensus_threshold,
        maintainer_approvals: maintainerApprovals,
        maintainer_rejections: maintainerRejections
      };
    }

    // Open: karma-weighted consensus with human review support
    let approvalWeight = 0;
    let rejectionWeight = 0;

    for (const review of approvals) {
      if (review.is_human) {
        approvalWeight += human_review_weight;
      } else {
        approvalWeight += Math.sqrt((review.karma || 0) + 1);
      }
    }

    for (const review of rejections) {
      if (review.is_human) {
        rejectionWeight += human_review_weight;
      } else {
        rejectionWeight += Math.sqrt((review.karma || 0) + 1);
      }
    }

    const totalWeight = approvalWeight + rejectionWeight;

    if (totalWeight === 0) {
      return { reached: false, reason: 'no_reviews' };
    }

    const ratio = approvalWeight / totalWeight;
    return {
      reached: ratio >= consensus_threshold,
      reason: ratio >= consensus_threshold ? 'consensus_reached' : 'below_threshold',
      ratio: Math.round(ratio * 100) / 100,
      threshold: consensus_threshold,
      approval_weight: Math.round(approvalWeight * 100) / 100,
      rejection_weight: Math.round(rejectionWeight * 100) / 100,
      approvals: approvals.length,
      rejections: rejections.length
    };
  }

  /**
   * Check if branch rule requires tests to pass
   * @param {string} repoId - Repository UUID
   * @param {string} branch - Branch name
   * @returns {Promise<boolean>}
   */
  async requiresTestsPass(repoId, branch) {
    const rules = await this.query(`
      SELECT require_tests_pass FROM gitswarm_branch_rules
      WHERE repo_id = $1
      ORDER BY priority DESC, LENGTH(branch_pattern) DESC
    `, [repoId]);

    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        return rule.require_tests_pass;
      }
    }

    return false; // Default: tests not required
  }

  /**
   * Get required approvals for a branch
   * @param {string} repoId - Repository UUID
   * @param {string} branch - Branch name
   * @returns {Promise<number>}
   */
  async getRequiredApprovals(repoId, branch) {
    // First check branch rules
    const rules = await this.query(`
      SELECT required_approvals FROM gitswarm_branch_rules
      WHERE repo_id = $1
      ORDER BY priority DESC, LENGTH(branch_pattern) DESC
    `, [repoId]);

    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        return rule.required_approvals;
      }
    }

    // Fall back to repo default
    const repo = await this.query(`
      SELECT min_reviews FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    return repo.rows[0]?.min_reviews || 1;
  }

  /**
   * Match branch against pattern (supports wildcards)
   * @param {string} branch - Branch name
   * @param {string} pattern - Pattern with optional wildcards
   * @returns {boolean}
   */
  matchesBranchPattern(branch, pattern) {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return branch === pattern;

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(branch);
  }

  /**
   * Check if agent is a maintainer of a repository
   * @param {string} agentId - Agent UUID
   * @param {string} repoId - Repository UUID
   * @returns {Promise<{isMaintainer: boolean, role?: string}>}
   */
  async isMaintainer(agentId, repoId) {
    const result = await this.query(`
      SELECT role FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (result.rows.length === 0) {
      return { isMaintainer: false };
    }

    return { isMaintainer: true, role: result.rows[0].role };
  }

  /**
   * Check if agent is the owner of a repository
   * @param {string} agentId - Agent UUID
   * @param {string} repoId - Repository UUID
   * @returns {Promise<boolean>}
   */
  async isOwner(agentId, repoId) {
    const result = await this.query(`
      SELECT 1 FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2 AND role = 'owner'
    `, [repoId, agentId]);

    return result.rows.length > 0;
  }

  /**
   * Check karma-based repo creation limits for platform org
   * @param {string} agentId - Agent UUID
   * @returns {Promise<{allowed: boolean, limit: object, used: object}>}
   */
  async checkRepoCreationLimit(agentId) {
    // Get agent karma
    const agent = await this.query(`SELECT karma FROM agents WHERE id = $1`, [agentId]);
    const karma = agent.rows[0]?.karma || 0;

    // Karma tier limits
    const tiers = [
      { minKarma: 0, daily: 0, weekly: 0, monthly: 0 },
      { minKarma: 100, daily: 1, weekly: 2, monthly: 5 },
      { minKarma: 500, daily: 2, weekly: 5, monthly: 15 },
      { minKarma: 1000, daily: 5, weekly: 15, monthly: 50 },
      { minKarma: 5000, daily: 10, weekly: 30, monthly: 100 },
      { minKarma: 10000, daily: 20, weekly: 60, monthly: -1 }, // -1 = unlimited
    ];

    // Find applicable tier
    let tier = tiers[0];
    for (const t of tiers) {
      if (karma >= t.minKarma) tier = t;
    }

    if (tier.daily === 0) {
      return {
        allowed: false,
        reason: 'karma_too_low',
        karma,
        required_karma: 100
      };
    }

    // Get usage counts
    const usage = await this.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') as daily,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as weekly,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as monthly
      FROM gitswarm_repos r
      JOIN gitswarm_maintainers m ON m.repo_id = r.id
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE m.agent_id = $1 AND m.role = 'owner' AND o.is_platform_org = true
    `, [agentId]);

    const used = {
      daily: parseInt(usage.rows[0]?.daily || 0),
      weekly: parseInt(usage.rows[0]?.weekly || 0),
      monthly: parseInt(usage.rows[0]?.monthly || 0)
    };

    // Check limits
    if (used.daily >= tier.daily) {
      return { allowed: false, reason: 'daily_limit_reached', limit: tier, used };
    }
    if (used.weekly >= tier.weekly) {
      return { allowed: false, reason: 'weekly_limit_reached', limit: tier, used };
    }
    if (tier.monthly !== -1 && used.monthly >= tier.monthly) {
      return { allowed: false, reason: 'monthly_limit_reached', limit: tier, used };
    }

    return { allowed: true, limit: tier, used, karma };
  }
}

// Export singleton instance
export const gitswarmPermissions = new GitSwarmPermissionService();
