/**
 * Shared Permission Service
 *
 * Unified permission resolution and consensus checking for both
 * CLI (SQLite) and web server (PostgreSQL). Database-agnostic.
 *
 * Uses PostgreSQL-style $N parameters. CLI consumers should wrap
 * with createSqliteAdapter() from query-adapter.js.
 *
 * Table names are resolved via the t() function so the same logic
 * works with prefixed (gitswarm_repos) and unprefixed (repos) tables.
 */
export class PermissionService {
  /**
   * @param {object} opts
   * @param {function} opts.query - async (sql, params) => { rows: [...] }
   * @param {function} opts.t     - (logicalName) => actualTableName
   */
  constructor({ query, t = (name) => name }) {
    this.query = query;
    this.t = t;
  }

  /**
   * Resolve effective permissions for an agent on a repository.
   * Priority: explicit grant > maintainer role > repo/org settings > karma.
   */
  async resolvePermissions(agentId, repoId) {
    const t = this.t;

    // 1. Explicit access grant
    const explicit = await this.query(`
      SELECT access_level, expires_at
      FROM ${t('repo_access')}
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (explicit.rows.length > 0) {
      const { access_level, expires_at } = explicit.rows[0];
      if (expires_at && new Date(expires_at) < new Date()) {
        await this.query(`
          DELETE FROM ${t('repo_access')} WHERE repo_id = $1 AND agent_id = $2
        `, [repoId, agentId]);
      } else {
        return { level: access_level, source: 'explicit' };
      }
    }

    // 2. Maintainer status
    const maintainer = await this.query(`
      SELECT role FROM ${t('maintainers')}
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length > 0) {
      const level = maintainer.rows[0].role === 'owner' ? 'admin' : 'maintain';
      return { level, source: 'maintainer', role: maintainer.rows[0].role };
    }

    // 3. Repo settings (with optional org join)
    const repo = await this.query(`
      SELECT agent_access, min_karma, is_private, ownership_model
      FROM ${t('repos')}
      WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { level: 'none', source: 'not_found' };
    }

    const { agent_access, min_karma, is_private } = repo.rows[0];

    // 4. Agent karma
    const agent = await this.query(
      `SELECT karma FROM ${t('agents')} WHERE id = $1`, [agentId]
    );
    // BUG-13 fix: Explicit numeric coercion to prevent string comparison
    const agentKarma = Number(agent.rows[0]?.karma ?? 0);

    const accessMode = agent_access || 'none';
    const karmaThreshold = Number(min_karma ?? 0);

    switch (accessMode) {
      case 'public':
        return { level: 'write', source: 'public' };

      case 'karma_threshold':
        if (agentKarma >= karmaThreshold) {
          return { level: 'write', source: 'karma', threshold: karmaThreshold, karma: agentKarma };
        }
        if (is_private) {
          return { level: 'none', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };
        }
        return { level: 'read', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };

      case 'allowlist':
        return { level: 'none', source: 'not_allowlisted' };

      default:
        if (!is_private) return { level: 'read', source: 'public_read' };
        return { level: 'none', source: 'private' };
    }
  }

  /**
   * Check if an agent can perform a specific action.
   */
  async canPerform(agentId, repoId, action) {
    const permissions = await this.resolvePermissions(agentId, repoId);
    const actionLevels = {
      read:     ['read', 'write', 'maintain', 'admin'],
      write:    ['write', 'maintain', 'admin'],
      merge:    ['maintain', 'admin'],
      settings: ['admin'],
      delete:   ['admin'],
    };
    const allowed = (actionLevels[action] || []).includes(permissions.level);
    return { allowed, permissions };
  }

  /**
   * Check branch-specific push permissions.
   */
  async canPushToBranch(agentId, repoId, branch) {
    const t = this.t;
    const permissions = await this.resolvePermissions(agentId, repoId);

    if (permissions.level === 'none' || permissions.level === 'read') {
      return { allowed: false, reason: 'insufficient_permissions', permissions };
    }

    const rules = await this.query(`
      SELECT * FROM ${t('branch_rules')}
      WHERE repo_id = $1
      ORDER BY priority DESC
    `, [repoId]);

    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        switch (rule.direct_push) {
          case 'none':
            return { allowed: false, reason: 'branch_protected', rule };
          case 'maintainers': {
            const ok = permissions.level === 'maintain' || permissions.level === 'admin';
            return { allowed: ok, reason: ok ? 'maintainer' : 'maintainers_only', rule };
          }
          case 'all':
            return { allowed: true, reason: 'allowed', rule };
        }
      }
    }

    return { allowed: true, reason: 'no_branch_rule', permissions };
  }

  /**
   * Check whether consensus is reached for merging a stream.
   *
   * Supports three ownership models:
   *   solo  - owner/maintainer must approve
   *   guild - maintainer majority exceeds threshold
   *   open  - karma-weighted community vote
   */
  async checkConsensus(streamId, repoId) {
    const t = this.t;

    const repo = await this.query(`
      SELECT consensus_threshold, min_reviews, ownership_model, merge_mode, human_review_weight
      FROM ${t('repos')} WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { reached: false, reason: 'repo_not_found' };
    }

    const { consensus_threshold, min_reviews, ownership_model, merge_mode, human_review_weight } = repo.rows[0];

    // Swarm mode: consensus is automatic
    if (merge_mode === 'swarm') {
      return { reached: true, reason: 'swarm_mode' };
    }

    // Get stream reviews with reviewer metadata
    const reviews = await this.query(`
      SELECT
        sr.verdict, sr.tested, sr.is_human, a.karma,
        CASE WHEN m.agent_id IS NOT NULL THEN true ELSE false END as is_maintainer
      FROM ${t('stream_reviews')} sr
      LEFT JOIN ${t('agents')} a ON sr.reviewer_id = a.id
      LEFT JOIN ${t('maintainers')} m ON m.repo_id = $2 AND m.agent_id = sr.reviewer_id
      WHERE sr.stream_id = $1
    `, [streamId, repoId]);

    const approvals  = reviews.rows.filter(r => r.verdict === 'approve');
    const rejections = reviews.rows.filter(r =>
      r.verdict === 'request_changes'
    );

    // Check minimum reviews
    if (reviews.rows.length < min_reviews) {
      return {
        reached: false,
        reason: 'insufficient_reviews',
        current: reviews.rows.length,
        required: min_reviews,
      };
    }

    // Solo: owner/maintainer must approve
    if (ownership_model === 'solo') {
      const ownerApproval = approvals.some(r => r.is_maintainer);
      return {
        reached: ownerApproval,
        reason: ownerApproval ? 'owner_approved' : 'awaiting_owner',
        approvals: approvals.length,
        rejections: rejections.length,
      };
    }

    // Guild: maintainer consensus
    if (ownership_model === 'guild') {
      const ma = approvals.filter(r => r.is_maintainer).length;
      const mr = rejections.filter(r => r.is_maintainer).length;
      const total = ma + mr;
      if (total === 0) return { reached: false, reason: 'no_maintainer_reviews' };
      const ratio = ma / total;
      return {
        reached: ratio >= consensus_threshold,
        reason: ratio >= consensus_threshold ? 'consensus_reached' : 'below_threshold',
        ratio: Math.round(ratio * 100) / 100,
        threshold: consensus_threshold,
        maintainer_approvals: ma,
        maintainer_rejections: mr,
      };
    }

    // Open: karma-weighted consensus
    let approvalWeight = 0;
    let rejectionWeight = 0;

    for (const r of approvals) {
      approvalWeight += r.is_human
        ? (human_review_weight || 1.5)
        : Math.sqrt((r.karma || 0) + 1);
    }
    for (const r of rejections) {
      rejectionWeight += r.is_human
        ? (human_review_weight || 1.5)
        : Math.sqrt((r.karma || 0) + 1);
    }

    const totalWeight = approvalWeight + rejectionWeight;
    if (totalWeight === 0) return { reached: false, reason: 'no_reviews' };

    const ratio = approvalWeight / totalWeight;
    return {
      reached: ratio >= consensus_threshold,
      reason: ratio >= consensus_threshold ? 'consensus_reached' : 'below_threshold',
      ratio: Math.round(ratio * 100) / 100,
      threshold: consensus_threshold,
      approval_weight: Math.round(approvalWeight * 100) / 100,
      rejection_weight: Math.round(rejectionWeight * 100) / 100,
      approvals: approvals.length,
      rejections: rejections.length,
    };
  }

  /**
   * Check if branch rule requires tests to pass.
   */
  async requiresTestsPass(repoId, branch) {
    const rules = await this.query(`
      SELECT require_tests_pass, branch_pattern FROM ${this.t('branch_rules')}
      WHERE repo_id = $1
      ORDER BY priority DESC
    `, [repoId]);

    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        return rule.require_tests_pass;
      }
    }
    return false;
  }

  /**
   * Get required approvals for a branch.
   */
  async getRequiredApprovals(repoId, branch) {
    const t = this.t;

    const rules = await this.query(`
      SELECT required_approvals, branch_pattern FROM ${t('branch_rules')}
      WHERE repo_id = $1
      ORDER BY priority DESC
    `, [repoId]);

    for (const rule of rules.rows) {
      if (this.matchesBranchPattern(branch, rule.branch_pattern)) {
        return rule.required_approvals;
      }
    }

    const repo = await this.query(
      `SELECT min_reviews FROM ${t('repos')} WHERE id = $1`, [repoId]
    );
    return repo.rows[0]?.min_reviews || 1;
  }

  /**
   * Check if agent is a maintainer.
   */
  async isMaintainer(agentId, repoId) {
    const r = await this.query(`
      SELECT role FROM ${this.t('maintainers')}
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (r.rows.length === 0) return { isMaintainer: false };
    return { isMaintainer: true, role: r.rows[0].role };
  }

  /**
   * Check if agent is the owner of a repository.
   */
  async isOwner(agentId, repoId) {
    const r = await this.query(`
      SELECT 1 FROM ${this.t('maintainers')}
      WHERE repo_id = $1 AND agent_id = $2 AND role = 'owner'
    `, [repoId, agentId]);
    return r.rows.length > 0;
  }

  /**
   * Match branch name against a glob pattern.
   */
  matchesBranchPattern(branch, pattern) {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return branch === pattern;
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return re.test(branch);
  }
}
