/**
 * CLI Safe Outputs Enforcer
 *
 * Lightweight version of the server's SafeOutputsEnforcer for local
 * plugin execution. Tracks per-execution budgets in memory and uses
 * the SQLite activity_log for rate limiting.
 *
 * Mirrors the server's DEFAULT_LIMITS and ACTION_COST_MAP to ensure
 * consistent enforcement across CLI and server.
 */

// Default limits — identical to server (src/services/safe-outputs.js)
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

// Action-to-budget mapping — identical to server
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

export class CliSafeOutputs {
  /**
   * @param {object} store - SQLite store (for rate limit queries via activity_log)
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * Create an execution context for tracking budget consumption.
   */
  createContext(plugin) {
    const limits = { ...DEFAULT_LIMITS, ...plugin.safe_outputs };
    return {
      pluginName: plugin.name,
      limits,
      usage: {},
      blocked: [],
    };
  }

  /**
   * Check if an action is allowed within budget.
   */
  checkAction(context, actionName, count = 1) {
    const limitKey = ACTION_COST_MAP[actionName];
    if (!limitKey) return { allowed: true };

    const limit = context.limits[limitKey];
    if (limit === undefined) return { allowed: true };

    const currentUsage = context.usage[limitKey] || 0;
    if (currentUsage + count > limit) {
      const reason = `Safe output limit exceeded: ${actionName} would use ${currentUsage + count}/${limit} of ${limitKey}`;
      context.blocked.push({ action: actionName, reason, timestamp: new Date().toISOString() });
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Record that an action was consumed.
   */
  recordAction(context, actionName, count = 1) {
    const limitKey = ACTION_COST_MAP[actionName];
    if (!limitKey) return;
    context.usage[limitKey] = (context.usage[limitKey] || 0) + count;
  }

  /**
   * Check rate limits using activity_log as the backing store.
   * Returns { allowed: boolean, reason?: string }
   */
  checkRateLimit(pluginName, limits) {
    if (!this.store) return { allowed: true };

    const now = new Date();

    // Check hourly limit
    if (limits.max_executions_per_hour) {
      const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
      try {
        const result = this.store.db.prepare(`
          SELECT COUNT(*) as cnt FROM activity_log
          WHERE event_type = 'plugin_executed' AND metadata LIKE ?
            AND created_at > ?
        `).get(`%"plugin":"${pluginName}"%`, hourAgo);

        if (result && result.cnt >= limits.max_executions_per_hour) {
          return { allowed: false, reason: `Hourly rate limit: ${result.cnt}/${limits.max_executions_per_hour}` };
        }
      } catch {
        // activity_log query failed — allow by default
      }
    }

    // Check daily limit
    if (limits.max_executions_per_day) {
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      try {
        const result = this.store.db.prepare(`
          SELECT COUNT(*) as cnt FROM activity_log
          WHERE event_type = 'plugin_executed' AND metadata LIKE ?
            AND created_at > ?
        `).get(`%"plugin":"${pluginName}"%`, dayAgo);

        if (result && result.cnt >= limits.max_executions_per_day) {
          return { allowed: false, reason: `Daily rate limit: ${result.cnt}/${limits.max_executions_per_day}` };
        }
      } catch {
        // allow by default
      }
    }

    // Check cooldown
    if (limits.cooldown_seconds) {
      const cooldownCutoff = new Date(now - limits.cooldown_seconds * 1000).toISOString();
      try {
        const result = this.store.db.prepare(`
          SELECT created_at FROM activity_log
          WHERE event_type = 'plugin_executed' AND metadata LIKE ?
            AND created_at > ?
          ORDER BY created_at DESC LIMIT 1
        `).get(`%"plugin":"${pluginName}"%`, cooldownCutoff);

        if (result) {
          const elapsed = (now - new Date(result.created_at)) / 1000;
          return { allowed: false, reason: `Cooldown: ${Math.ceil(limits.cooldown_seconds - elapsed)}s remaining` };
        }
      } catch {
        // allow by default
      }
    }

    return { allowed: true };
  }

  /**
   * Get summary for logging.
   */
  getSummary(context) {
    return {
      usage: { ...context.usage },
      blocked: context.blocked,
      limits: context.limits,
    };
  }
}

export { DEFAULT_LIMITS, ACTION_COST_MAP };
