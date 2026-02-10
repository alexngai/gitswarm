/**
 * Safe Outputs Enforcement Layer
 *
 * Every plugin declares a mutation budget (safe_outputs). This service
 * tracks consumption during an execution and blocks actions that would
 * exceed the budget. Inspired by the agentbook pattern where agents
 * are sandboxed with strict limits on what they can mutate.
 */

// Default limits applied when a plugin doesn't declare a specific budget
const DEFAULT_LIMITS = {
  max_comments: 2,
  max_label_additions: 3,
  max_label_removals: 1,
  max_merges: 1,
  max_branch_creates: 1,
  max_commits: 5,
  max_files_changed: 20,
  max_issue_closures: 1,
  max_prs: 1,
  max_approvals: 1,
  max_tags: 1,
  max_releases: 1,
  max_executions_per_hour: 10,
  max_executions_per_day: 50,
  cooldown_seconds: 60,
};

// Actions that map to safe output counters.
// Keys must match what plugins.yml uses (e.g., max_prs, max_merges).
const ACTION_COST_MAP = {
  'add_comment':            'max_comments',
  'post_summary':           'max_comments',
  'add_label':              'max_label_additions',
  'add_labels':             'max_label_additions',
  'remove_label':           'max_label_removals',
  'merge_to_buffer':        'max_merges',
  'merge_stream':           'max_merges',
  'merge_stream_to_buffer': 'max_merges',
  'promote_buffer_to_main': 'max_merges',
  'auto_approve':           'max_approvals',
  'auto_approve_review':    'max_approvals',
  'create_branch':          'max_branch_creates',
  'create_pr':              'max_prs',
  'create_github_pr':       'max_prs',
  'close_issue':            'max_issue_closures',
  'close_completed_tasks':  'max_issue_closures',
  'create_commit':          'max_commits',
  'tag_release':            'max_tags',
  'tag_release_semver_patch': 'max_tags',
  'create_release':         'max_releases',
  'notify_contributors':    'max_comments',
  'notify_stream_owner':    'max_comments',
};

export class SafeOutputsEnforcer {
  constructor(db) {
    this.db = db;
  }

  /**
   * Create an execution context that tracks safe output consumption.
   * Returns an object that must be passed to checkAction() before each mutation.
   */
  createContext(plugin) {
    const limits = { ...DEFAULT_LIMITS, ...plugin.safe_outputs };
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      limits,
      usage: {},
      blocked: [],
    };
  }

  /**
   * Check if an action is allowed within the current execution context.
   * Returns { allowed: boolean, reason?: string }
   */
  checkAction(context, actionName, count = 1) {
    const limitKey = ACTION_COST_MAP[actionName];
    if (!limitKey) {
      // Unknown action type — warn and allow by default (no budget tracking)
      console.warn(`Safe outputs: unknown action "${actionName}", allowing by default`);
      return { allowed: true };
    }

    const limit = context.limits[limitKey];
    if (limit === undefined) {
      return { allowed: true };
    }

    const currentUsage = context.usage[limitKey] || 0;
    if (currentUsage + count > limit) {
      const reason = `Safe output limit exceeded: ${actionName} would use ${currentUsage + count}/${limit} of ${limitKey}`;
      context.blocked.push({ action: actionName, reason, timestamp: new Date().toISOString() });
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Record that an action was taken (consume budget).
   * Call this AFTER the action succeeds.
   */
  recordAction(context, actionName, count = 1) {
    const limitKey = ACTION_COST_MAP[actionName];
    if (!limitKey) return;

    context.usage[limitKey] = (context.usage[limitKey] || 0) + count;
  }

  /**
   * Look up the budget key for an action name.
   * Used by the post-hoc audit to map webhook-observed actions to budget keys.
   */
  getActionBudgetKey(actionName) {
    return ACTION_COST_MAP[actionName] || null;
  }

  /**
   * Periodically clean up stale rate limit records older than 7 days.
   * Called opportunistically during rate limit checks (~2% of the time).
   */
  _cleanupStaleRateLimits() {
    if (!this.db) return;
    if (Math.random() > 0.02) return;

    this.db.query(`
      DELETE FROM gitswarm_plugin_rate_limits
      WHERE window_start < NOW() - INTERVAL '7 days'
    `).catch(err => console.error('Rate limit cleanup failed:', err.message));
  }

  /**
   * Check rate limits (per-hour and per-day execution counts).
   * Returns { allowed: boolean, reason?: string, retryAfter?: number }
   */
  async checkRateLimit(pluginId, limits) {
    if (!this.db) return { allowed: true };

    // Opportunistic cleanup of stale rate limit records
    this._cleanupStaleRateLimits();

    const now = new Date();

    // Check hourly limit
    if (limits.max_executions_per_hour) {
      const hourStart = new Date(now);
      hourStart.setMinutes(0, 0, 0);

      const hourResult = await this.db.query(`
        SELECT execution_count FROM gitswarm_plugin_rate_limits
        WHERE plugin_id = $1 AND window_start = $2 AND window_type = 'hour'
      `, [pluginId, hourStart]);

      const hourCount = hourResult.rows[0]?.execution_count || 0;
      if (hourCount >= limits.max_executions_per_hour) {
        const nextHour = new Date(hourStart);
        nextHour.setHours(nextHour.getHours() + 1);
        return {
          allowed: false,
          reason: `Hourly rate limit: ${hourCount}/${limits.max_executions_per_hour}`,
          retryAfter: Math.ceil((nextHour - now) / 1000),
        };
      }
    }

    // Check daily limit
    if (limits.max_executions_per_day) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);

      const dayResult = await this.db.query(`
        SELECT execution_count FROM gitswarm_plugin_rate_limits
        WHERE plugin_id = $1 AND window_start = $2 AND window_type = 'day'
      `, [pluginId, dayStart]);

      const dayCount = dayResult.rows[0]?.execution_count || 0;
      if (dayCount >= limits.max_executions_per_day) {
        const nextDay = new Date(dayStart);
        nextDay.setDate(nextDay.getDate() + 1);
        return {
          allowed: false,
          reason: `Daily rate limit: ${dayCount}/${limits.max_executions_per_day}`,
          retryAfter: Math.ceil((nextDay - now) / 1000),
        };
      }
    }

    // Check cooldown
    if (limits.cooldown_seconds) {
      const lastExec = await this.db.query(`
        SELECT created_at FROM gitswarm_plugin_executions
        WHERE plugin_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [pluginId]);

      if (lastExec.rows.length > 0) {
        const elapsed = (now - new Date(lastExec.rows[0].created_at)) / 1000;
        if (elapsed < limits.cooldown_seconds) {
          return {
            allowed: false,
            reason: `Cooldown: ${Math.ceil(limits.cooldown_seconds - elapsed)}s remaining`,
            retryAfter: Math.ceil(limits.cooldown_seconds - elapsed),
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Increment rate limit counters after an execution starts.
   */
  async incrementRateLimit(pluginId) {
    if (!this.db) return;

    const now = new Date();

    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);

    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);

    // Upsert hourly counter
    await this.db.query(`
      INSERT INTO gitswarm_plugin_rate_limits (plugin_id, window_start, window_type, execution_count)
      VALUES ($1, $2, 'hour', 1)
      ON CONFLICT (plugin_id, window_start, window_type) DO UPDATE
        SET execution_count = gitswarm_plugin_rate_limits.execution_count + 1
    `, [pluginId, hourStart]);

    // Upsert daily counter
    await this.db.query(`
      INSERT INTO gitswarm_plugin_rate_limits (plugin_id, window_start, window_type, execution_count)
      VALUES ($1, $2, 'day', 1)
      ON CONFLICT (plugin_id, window_start, window_type) DO UPDATE
        SET execution_count = gitswarm_plugin_rate_limits.execution_count + 1
    `, [pluginId, dayStart]);
  }

  /**
   * Get the execution summary for logging/audit.
   */
  getSummary(context) {
    return {
      usage: { ...context.usage },
      blocked: context.blocked,
      limits: context.limits,
    };
  }
}

export default SafeOutputsEnforcer;
