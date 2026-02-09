/**
 * Permission resolution for federation repos.
 *
 * Portable, database-agnostic – accepts any object with a `.query(sql, params)`
 * method that returns `{ rows: [...] }`.
 */
export class PermissionService {
  constructor(store) {
    this.query = store.query.bind(store);
  }

  /** Resolve effective permissions for an agent on a repo. */
  async resolvePermissions(agentId, repoId) {
    // 1. Explicit access grant
    const explicit = await this.query(
      `SELECT access_level, expires_at FROM repo_access
       WHERE repo_id = ? AND agent_id = ?`,
      [repoId, agentId]
    );

    if (explicit.rows.length > 0) {
      const { access_level, expires_at } = explicit.rows[0];
      if (expires_at && new Date(expires_at) < new Date()) {
        await this.query(
          `DELETE FROM repo_access WHERE repo_id = ? AND agent_id = ?`,
          [repoId, agentId]
        );
      } else {
        return { level: access_level, source: 'explicit' };
      }
    }

    // 2. Maintainer status
    const maintainer = await this.query(
      `SELECT role FROM maintainers WHERE repo_id = ? AND agent_id = ?`,
      [repoId, agentId]
    );
    if (maintainer.rows.length > 0) {
      const level = maintainer.rows[0].role === 'owner' ? 'admin' : 'maintain';
      return { level, source: 'maintainer', role: maintainer.rows[0].role };
    }

    // 3. Repo settings
    const repo = await this.query(
      `SELECT agent_access, min_karma, is_private, ownership_model FROM repos WHERE id = ?`,
      [repoId]
    );
    if (repo.rows.length === 0) return { level: 'none', source: 'not_found' };

    const { agent_access, min_karma, is_private } = repo.rows[0];

    // 4. Agent karma
    const agent = await this.query(`SELECT karma FROM agents WHERE id = ?`, [agentId]);
    const agentKarma = agent.rows[0]?.karma || 0;

    const accessMode = agent_access || 'none';
    const karmaThreshold = min_karma ?? 0;

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

  /** Check if agent can perform a specific action. */
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

  /** Check branch-specific push permissions. */
  async canPushToBranch(agentId, repoId, branch) {
    const permissions = await this.resolvePermissions(agentId, repoId);
    if (permissions.level === 'none' || permissions.level === 'read') {
      return { allowed: false, reason: 'insufficient_permissions', permissions };
    }

    const rules = await this.query(
      `SELECT * FROM branch_rules WHERE repo_id = ? ORDER BY priority DESC`,
      [repoId]
    );

    for (const rule of rules.rows) {
      if (this._matchBranch(branch, rule.branch_pattern)) {
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
   * Reviews are keyed by stream_id (v2 schema). The consensus algorithm
   * remains identical: solo (owner must approve), guild (maintainer majority),
   * open (karma-weighted community vote).
   */
  async checkConsensus(streamId, repoId) {
    const repo = await this.query(
      `SELECT consensus_threshold, min_reviews, ownership_model, human_review_weight
       FROM repos WHERE id = ?`,
      [repoId]
    );
    if (repo.rows.length === 0) return { reached: false, reason: 'repo_not_found' };

    const { consensus_threshold, min_reviews, ownership_model, human_review_weight } = repo.rows[0];

    const reviews = await this.query(
      `SELECT pr.verdict, pr.tested, pr.is_human, a.karma,
              CASE WHEN m.agent_id IS NOT NULL THEN 1 ELSE 0 END as is_maintainer
       FROM patch_reviews pr
       LEFT JOIN agents a ON pr.reviewer_id = a.id
       LEFT JOIN maintainers m ON m.repo_id = ? AND m.agent_id = pr.reviewer_id
       WHERE pr.stream_id = ?`,
      [repoId, streamId]
    );

    const approvals  = reviews.rows.filter(r => r.verdict === 'approve');
    const rejections = reviews.rows.filter(r => r.verdict === 'request_changes');

    if (reviews.rows.length < min_reviews) {
      return { reached: false, reason: 'insufficient_reviews', current: reviews.rows.length, required: min_reviews };
    }

    if (ownership_model === 'solo') {
      const ownerApproval = approvals.some(r => r.is_maintainer);
      return {
        reached: ownerApproval,
        reason: ownerApproval ? 'owner_approved' : 'awaiting_owner',
        approvals: approvals.length,
        rejections: rejections.length,
      };
    }

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
    let approvalWeight = 0, rejectionWeight = 0;
    for (const r of approvals) {
      approvalWeight += r.is_human ? human_review_weight : Math.sqrt((r.karma || 0) + 1);
    }
    for (const r of rejections) {
      rejectionWeight += r.is_human ? human_review_weight : Math.sqrt((r.karma || 0) + 1);
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

  async isMaintainer(agentId, repoId) {
    const r = await this.query(
      `SELECT role FROM maintainers WHERE repo_id = ? AND agent_id = ?`,
      [repoId, agentId]
    );
    if (r.rows.length === 0) return { isMaintainer: false };
    return { isMaintainer: true, role: r.rows[0].role };
  }

  // ── helpers ───────────────────────────────────────────────
  _matchBranch(branch, pattern) {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return branch === pattern;
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(branch);
  }
}
