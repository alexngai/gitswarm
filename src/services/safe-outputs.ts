/**
 * Safe Outputs Enforcement Layer
 *
 * Every plugin declares a mutation budget (safe_outputs). This service
 * tracks consumption during an execution and blocks actions that would
 * exceed the budget. Inspired by the agentbook pattern where agents
 * are sandboxed with strict limits on what they can mutate.
 */

interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

interface PluginConfig {
  id: any;
  name: any;
  safe_outputs?: Record<string, any>;
  [key: string]: any;
}

interface SafeOutputContext {
  pluginId: any;
  pluginName: any;
  limits: Record<string, any>;
  usage: Record<string, any>;
  blocked: Array<{ action: string; reason: string; timestamp: string }>;
  [key: string]: any;
}

interface CheckResult {
  allowed: boolean;
  reason?: string;
}

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
}

interface SafeOutputSummary {
  usage: Record<string, number>;
  blocked: Array<{ action: string; reason: string; timestamp: string }>;
  limits: Record<string, number>;
}

// Default limits applied when a plugin doesn't declare a specific budget
const DEFAULT_LIMITS: Record<string, number> = {
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
const ACTION_COST_MAP: Record<string, string> = {
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
  private db: DbClient | null;

  constructor(db: DbClient | null) {
    this.db = db;
  }

  /**
   * Create an execution context that tracks safe output consumption.
   * Returns an object that must be passed to checkAction() before each mutation.
   */
  createContext(plugin: any): SafeOutputContext {
    const limits: Record<string, number> = { ...DEFAULT_LIMITS, ...plugin.safe_outputs };
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
  checkAction(context: any, actionName: string, count: number = 1): CheckResult {
    const limitKey: string | undefined = ACTION_COST_MAP[actionName];
    if (!limitKey) {
      // Unknown action type -- warn and allow by default (no budget tracking)
      console.warn(`Safe outputs: unknown action "${actionName}", allowing by default`);
      return { allowed: true };
    }

    const limit: number | undefined = context.limits[limitKey];
    if (limit === undefined) {
      return { allowed: true };
    }

    const currentUsage: number = context.usage[limitKey] || 0;
    if (currentUsage + count > limit) {
      const reason: string = `Safe output limit exceeded: ${actionName} would use ${currentUsage + count}/${limit} of ${limitKey}`;
      context.blocked.push({ action: actionName, reason, timestamp: new Date().toISOString() });
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Record that an action was taken (consume budget).
   * Call this AFTER the action succeeds.
   */
  recordAction(context: any, actionName: string, count: number = 1): void {
    const limitKey: string | undefined = ACTION_COST_MAP[actionName];
    if (!limitKey) return;

    context.usage[limitKey] = (context.usage[limitKey] || 0) + count;
  }

  /**
   * Look up the budget key for an action name.
   * Used by the post-hoc audit to map webhook-observed actions to budget keys.
   */
  getActionBudgetKey(actionName: string): string | null {
    return ACTION_COST_MAP[actionName] || null;
  }

  /**
   * Periodically clean up stale rate limit records older than 7 days.
   * Called opportunistically during rate limit checks (~2% of the time).
   */
  _cleanupStaleRateLimits(): void {
    if (!this.db) return;
    if (Math.random() > 0.02) return;

    this.db.query(`
      DELETE FROM gitswarm_plugin_rate_limits
      WHERE window_start < NOW() - INTERVAL '7 days'
    `).catch((err: Error) => console.error('Rate limit cleanup failed:', err.message));
  }

  /**
   * Check rate limits (per-hour and per-day execution counts).
   * Returns { allowed: boolean, reason?: string, retryAfter?: number }
   */
  async checkRateLimit(pluginId: string, limits: Record<string, number>): Promise<RateLimitResult> {
    if (!this.db) return { allowed: true };

    // Opportunistic cleanup of stale rate limit records
    this._cleanupStaleRateLimits();

    const now: Date = new Date();

    // Check hourly limit
    if (limits.max_executions_per_hour) {
      const hourStart: Date = new Date(now);
      hourStart.setMinutes(0, 0, 0);

      const hourResult = await this.db.query(`
        SELECT execution_count FROM gitswarm_plugin_rate_limits
        WHERE plugin_id = $1 AND window_start = $2 AND window_type = 'hour'
      `, [pluginId, hourStart]);

      const hourCount: number = (hourResult.rows[0]?.execution_count as number) || 0;
      if (hourCount >= limits.max_executions_per_hour) {
        const nextHour: Date = new Date(hourStart);
        nextHour.setHours(nextHour.getHours() + 1);
        return {
          allowed: false,
          reason: `Hourly rate limit: ${hourCount}/${limits.max_executions_per_hour}`,
          retryAfter: Math.ceil((nextHour.getTime() - now.getTime()) / 1000),
        };
      }
    }

    // Check daily limit
    if (limits.max_executions_per_day) {
      const dayStart: Date = new Date(now);
      dayStart.setHours(0, 0, 0, 0);

      const dayResult = await this.db.query(`
        SELECT execution_count FROM gitswarm_plugin_rate_limits
        WHERE plugin_id = $1 AND window_start = $2 AND window_type = 'day'
      `, [pluginId, dayStart]);

      const dayCount: number = (dayResult.rows[0]?.execution_count as number) || 0;
      if (dayCount >= limits.max_executions_per_day) {
        const nextDay: Date = new Date(dayStart);
        nextDay.setDate(nextDay.getDate() + 1);
        return {
          allowed: false,
          reason: `Daily rate limit: ${dayCount}/${limits.max_executions_per_day}`,
          retryAfter: Math.ceil((nextDay.getTime() - now.getTime()) / 1000),
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
        const elapsed: number = (now.getTime() - new Date(lastExec.rows[0].created_at as string).getTime()) / 1000;
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
  async incrementRateLimit(pluginId: string): Promise<void> {
    if (!this.db) return;

    const now: Date = new Date();

    const hourStart: Date = new Date(now);
    hourStart.setMinutes(0, 0, 0);

    const dayStart: Date = new Date(now);
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
  getSummary(context: any): SafeOutputSummary {
    return {
      usage: { ...context.usage },
      blocked: context.blocked,
      limits: context.limits,
    };
  }
}

export default SafeOutputsEnforcer;
