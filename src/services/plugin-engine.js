/**
 * Plugin Engine — Core Orchestrator
 *
 * The plugin engine receives events (from webhooks, gitswarm activity, or
 * scheduled triggers), matches them against registered plugins for the repo,
 * evaluates conditions, and dispatches execution.
 *
 * Key principle: this app is an ORCHESTRATOR, not a compute provider.
 * - Tier 1 (automation) plugins execute lightweight built-in actions
 * - Tier 2 (AI) plugins dispatch to GitHub Actions where installed agents
 *   (Claude, Codex, Copilot) provide compute
 * - Tier 3 (governance) plugins dispatch after gitswarm consensus events
 *
 * The engine never runs AI models itself. It dispatches work to the repo's
 * own GitHub Actions environment where the repo owner's installed agents do
 * the actual processing.
 */

import crypto from 'crypto';
import { githubApp, GitHubRepo } from './github.js';
import { SafeOutputsEnforcer } from './safe-outputs.js';

/**
 * Maps GitHub webhook event types to the trigger format used in plugins.yml.
 * GitHub sends event + action (e.g., event=issues, action=opened).
 * Plugins declare trigger as "issues.opened".
 */
function webhookToTrigger(githubEvent, action) {
  if (action) return `${githubEvent}.${action}`;
  return githubEvent;
}

/**
 * Maps gitswarm internal events to trigger format.
 * GitSwarm events are already in the right format, just prefixed.
 */
function gitswarmToTrigger(eventType) {
  return `gitswarm.${eventType}`;
}

export class PluginEngine {
  constructor(db, activityService) {
    this.db = db;
    this.activityService = activityService;
    this.safeOutputs = new SafeOutputsEnforcer(db);
  }

  /**
   * Process a GitHub webhook event through the plugin system.
   * Called from the webhook handler after normal processing.
   *
   * @param {string} githubEvent - GitHub event type (e.g., 'issues', 'push')
   * @param {object} payload - Full webhook payload
   */
  async processWebhookEvent(githubEvent, payload) {
    const repoId = await this._resolveRepoId(payload);
    if (!repoId) return { processed: false, reason: 'repo_not_found' };

    // Check if plugins are enabled for this repo
    const enabled = await this._pluginsEnabled(repoId);
    if (!enabled) return { processed: false, reason: 'plugins_disabled' };

    const action = payload.action;
    const trigger = webhookToTrigger(githubEvent, action);

    return this._processEvent(repoId, trigger, payload);
  }

  /**
   * Process a gitswarm internal event through the plugin system.
   * Called when gitswarm activity events fire (consensus_reached, etc.).
   *
   * @param {string} repoId - The gitswarm repo UUID
   * @param {string} eventType - GitSwarm event type (e.g., 'consensus_reached')
   * @param {object} payload - Event metadata
   */
  async processGitswarmEvent(repoId, eventType, payload) {
    const enabled = await this._pluginsEnabled(repoId);
    if (!enabled) return { processed: false, reason: 'plugins_disabled' };

    const trigger = gitswarmToTrigger(eventType);
    return this._processEvent(repoId, trigger, payload);
  }

  /**
   * Core event processing: match plugins, evaluate conditions, dispatch.
   */
  async _processEvent(repoId, trigger, payload) {
    // Find all enabled plugins for this repo that match the trigger
    const plugins = await this._matchPlugins(repoId, trigger);
    if (plugins.length === 0) {
      return { processed: false, reason: 'no_matching_plugins', trigger };
    }

    const results = [];

    // Process plugins in priority order (highest first)
    for (const plugin of plugins) {
      try {
        const result = await this._executePlugin(plugin, trigger, payload);
        results.push({ plugin: plugin.name, ...result });
      } catch (err) {
        console.error(`Plugin ${plugin.name} failed:`, err.message);
        results.push({ plugin: plugin.name, status: 'error', error: err.message });

        // Record the failure
        await this._recordExecution(plugin, trigger, payload, 'failed', [], {}, err.message);
      }
    }

    return { processed: true, trigger, results };
  }

  /**
   * Execute a single plugin: check conditions, check rate limits,
   * create safe output context, dispatch.
   */
  async _executePlugin(plugin, trigger, payload) {
    // 1. Evaluate conditions (async — some conditions query gitswarm data)
    const conditionsMet = await this._evaluateConditions(plugin, plugin.conditions, payload);
    if (!conditionsMet) {
      return { status: 'skipped', reason: 'conditions_not_met' };
    }

    // 2. Check rate limits
    const limits = { ...plugin.safe_outputs };
    const rateCheck = await this.safeOutputs.checkRateLimit(plugin.id, limits);
    if (!rateCheck.allowed) {
      return { status: 'rate_limited', reason: rateCheck.reason, retryAfter: rateCheck.retryAfter };
    }

    // 3. Create safe output context
    const context = this.safeOutputs.createContext(plugin);

    // 4. Dispatch based on execution model
    let result;
    switch (plugin.execution_model) {
      case 'builtin':
        result = await this._executeBuiltin(plugin, trigger, payload, context);
        break;

      case 'dispatch':
        result = await this._dispatchToGitHubActions(plugin, trigger, payload, context);
        break;

      case 'workflow':
        result = await this._handleWorkflow(plugin, trigger, payload, context);
        break;

      case 'webhook':
        result = await this._dispatchToWebhook(plugin, trigger, payload, context);
        break;

      default:
        result = { status: 'error', reason: `Unknown execution model: ${plugin.execution_model}` };
    }

    // 5. Increment rate limit counters
    await this.safeOutputs.incrementRateLimit(plugin.id);

    // 6. Record execution (skip for models that create their own records)
    const modelsWithOwnRecords = ['dispatch', 'workflow'];
    if (!modelsWithOwnRecords.includes(plugin.execution_model) || result.status === 'workflow_native') {
      const summary = this.safeOutputs.getSummary(context);
      await this._recordExecution(
        plugin, trigger, payload,
        result.status, result.actionsTaken || [], summary
      );
    }

    // 7. Log activity
    if (this.activityService) {
      this.activityService.logActivity({
        event_type: 'plugin_execution',
        target_type: 'plugin',
        target_id: plugin.id,
        metadata: {
          repo_id: plugin.repo_id,
          plugin_name: plugin.name,
          trigger,
          status: result.status,
          actions_taken: result.actionsTaken?.length || 0,
        },
      }).catch(err => console.error('Failed to log plugin activity:', err));
    }

    return result;
  }

  /**
   * Execute a built-in plugin action (Tier 1 automation).
   * These are lightweight, deterministic actions that run on the gitswarm server.
   */
  async _executeBuiltin(plugin, trigger, payload, context) {
    const actions = Array.isArray(plugin.actions) ? plugin.actions : [];
    const actionsTaken = [];
    const repoId = plugin.repo_id;

    for (const action of actions) {
      const actionName = typeof action === 'string' ? action : action.name;

      // Check safe outputs before each action
      const check = this.safeOutputs.checkAction(context, actionName);
      if (!check.allowed) {
        console.log(`Plugin ${plugin.name}: action ${actionName} blocked — ${check.reason}`);
        continue;
      }

      try {
        switch (actionName) {
          case 'add_labels':
          case 'add_label': {
            const labels = this._resolveLabels(plugin, payload);
            if (labels.length > 0) {
              await this._addLabels(repoId, payload, labels);
              this.safeOutputs.recordAction(context, 'add_labels', labels.length);
              actionsTaken.push({ action: 'add_labels', labels });
            }
            break;
          }

          case 'add_comment':
          case 'post_summary': {
            const body = typeof action === 'object' ? action.body : null;
            if (body) {
              await this._addComment(repoId, payload, body);
              this.safeOutputs.recordAction(context, 'add_comment');
              actionsTaken.push({ action: 'add_comment' });
            }
            break;
          }

          case 'close_completed_tasks': {
            const closed = await this._closeCompletedTasks(repoId);
            if (closed > 0) {
              this.safeOutputs.recordAction(context, 'close_completed_tasks', closed);
              actionsTaken.push({ action: 'close_completed_tasks', count: closed });
            }
            break;
          }

          case 'notify_contributors': {
            const message = typeof action === 'object' ? action.message : 'A gitswarm event requires your attention.';
            const notified = await this._notifyContributors(repoId, payload, message);
            if (notified) {
              this.safeOutputs.recordAction(context, 'notify_contributors');
              actionsTaken.push({ action: 'notify_contributors', status: 'completed' });
            } else {
              actionsTaken.push({ action: 'notify_contributors', status: 'no_target' });
            }
            break;
          }

          case 'notify_stream_owner': {
            const ownerMsg = typeof action === 'object' ? action.message : 'Your stream needs attention.';
            const notifiedOwner = await this._notifyStreamOwner(repoId, payload, ownerMsg);
            if (notifiedOwner) {
              this.safeOutputs.recordAction(context, 'notify_stream_owner');
              actionsTaken.push({ action: 'notify_stream_owner', status: 'completed' });
            } else {
              actionsTaken.push({ action: 'notify_stream_owner', status: 'no_target' });
            }
            break;
          }

          case 'promote_buffer_to_main':
          case 'promote': {
            const promoteResult = await this._promoteBufferToMain(repoId);
            if (promoteResult.success) {
              this.safeOutputs.recordAction(context, 'promote_buffer_to_main');
              actionsTaken.push({
                action: 'promote_buffer_to_main',
                status: 'completed',
                from: promoteResult.from,
                to: promoteResult.to,
                sha: promoteResult.sha,
              });
            } else {
              actionsTaken.push({
                action: 'promote_buffer_to_main',
                status: 'failed',
                reason: promoteResult.reason,
              });
            }
            break;
          }

          default:
            // Unknown built-in action — skip
            actionsTaken.push({ action: actionName, status: 'unknown_action' });
        }
      } catch (err) {
        console.error(`Plugin ${plugin.name}: action ${actionName} failed:`, err.message);
        actionsTaken.push({ action: actionName, status: 'error', error: err.message });
      }
    }

    return { status: 'completed', actionsTaken };
  }

  /**
   * Dispatch a plugin execution to GitHub Actions via repository_dispatch.
   * The actual AI compute (Claude, Codex, Copilot) runs in the repo's
   * GitHub Actions environment — not on our server.
   */
  async _dispatchToGitHubActions(plugin, trigger, payload, context) {
    const repoId = plugin.repo_id;

    // Get repo info and installation token
    const repo = await this.db.query(`
      SELECT r.github_full_name, o.github_installation_id
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { status: 'error', reason: 'repo_not_found' };
    }

    const { github_full_name, github_installation_id } = repo.rows[0];
    if (!github_installation_id) {
      return { status: 'error', reason: 'no_installation' };
    }

    const [owner, repoName] = github_full_name.split('/');

    let token;
    try {
      token = await githubApp.getInstallationToken(github_installation_id);
    } catch (err) {
      return { status: 'error', reason: `token_failed: ${err.message}` };
    }

    const ghRepo = new GitHubRepo(token, owner, repoName);

    // Build the dispatch payload
    const eventType = plugin.dispatch_target || `gitswarm.plugin.${plugin.name}`;

    // Create an execution record first so we can track it
    const execResult = await this.db.query(`
      INSERT INTO gitswarm_plugin_executions (
        repo_id, plugin_id, trigger_event, trigger_payload, status, started_at
      ) VALUES ($1, $2, $3, $4, 'dispatched', NOW())
      RETURNING id
    `, [repoId, plugin.id, trigger, JSON.stringify(this._sanitizePayload(payload))]);

    const executionId = execResult.rows[0].id;

    // Generate execution token for secure reporting
    const executionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(executionToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await this.db.query(`
      UPDATE gitswarm_plugin_executions
      SET dispatch_token_hash = $2, dispatch_token_expires_at = $3
      WHERE id = $1
    `, [executionId, tokenHash, tokenExpiry]);

    const clientPayload = {
      gitswarm: {
        execution_id: executionId,
        execution_token: executionToken,
        plugin_name: plugin.name,
        plugin_tier: plugin.tier,
        trigger,
        actions: plugin.actions,
        safe_outputs: plugin.safe_outputs,
        config: plugin.config,
      },
      event: this._sanitizePayload(payload),
    };

    try {
      await ghRepo.request(
        'POST',
        `/repos/${owner}/${repoName}/dispatches`,
        {
          event_type: eventType,
          client_payload: clientPayload,
        }
      );

      return {
        status: 'dispatched',
        dispatchId: executionId,
        eventType,
        actionsTaken: [{ action: 'repository_dispatch', event_type: eventType }],
      };
    } catch (err) {
      // Update execution record
      await this.db.query(`
        UPDATE gitswarm_plugin_executions
        SET status = 'failed', error_message = $2, completed_at = NOW()
        WHERE id = $1
      `, [executionId, err.message]);

      return { status: 'dispatch_failed', reason: err.message };
    }
  }

  /**
   * Dispatch to an external webhook.
   */
  async _dispatchToWebhook(plugin, trigger, payload, context) {
    const webhookUrl = plugin.config?.webhook_url || plugin.dispatch_target;
    if (!webhookUrl) {
      return { status: 'error', reason: 'no_webhook_url' };
    }

    const body = {
      gitswarm: {
        plugin_name: plugin.name,
        trigger,
        actions: plugin.actions,
        safe_outputs: plugin.safe_outputs,
      },
      event: this._sanitizePayload(payload),
    };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitSwarm-Plugin': plugin.name,
          'X-GitSwarm-Trigger': trigger,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      return {
        status: response.ok ? 'dispatched' : 'dispatch_failed',
        httpStatus: response.status,
        actionsTaken: [{ action: 'webhook_dispatch', url: webhookUrl, status: response.status }],
      };
    } catch (err) {
      return { status: 'dispatch_failed', reason: err.message };
    }
  }

  /**
   * Handle a GitHub Actions workflow plugin.
   *
   * Workflows that listen on native GitHub events (issues.opened,
   * pull_request.opened) execute directly via GitHub Actions — they don't
   * need us to dispatch. We just record the execution for tracking.
   *
   * Workflows that listen on repository_dispatch (gitswarm-specific
   * events like consensus_reached) DO need us to dispatch, since GitHub
   * won't fire repository_dispatch on its own for these events.
   */
  async _handleWorkflow(plugin, trigger, payload, context) {
    const isGitSwarmTrigger = trigger.startsWith('gitswarm.');
    const isDispatchTrigger = trigger.startsWith('gitswarm.plugin.');

    if (!isGitSwarmTrigger) {
      // Native GitHub event — the workflow fires on its own via
      // GitHub Actions. We just record that it was triggered for audit.
      return {
        status: 'workflow_native',
        actionsTaken: [{
          action: 'workflow_native_trigger',
          workflow: plugin.dispatch_target,
          note: 'Workflow triggered directly by GitHub Actions, no dispatch needed',
        }],
      };
    }

    // GitSwarm-specific event — we need to dispatch via repository_dispatch
    // so the workflow's `repository_dispatch` trigger fires.
    const repoId = plugin.repo_id;

    const repo = await this.db.query(`
      SELECT r.github_full_name, o.github_installation_id
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { status: 'error', reason: 'repo_not_found' };
    }

    const { github_full_name, github_installation_id } = repo.rows[0];
    if (!github_installation_id) {
      return { status: 'error', reason: 'no_installation' };
    }

    const [owner, repoName] = github_full_name.split('/');

    let token;
    try {
      token = await githubApp.getInstallationToken(github_installation_id);
    } catch (err) {
      return { status: 'error', reason: `token_failed: ${err.message}` };
    }

    const ghRepo = new GitHubRepo(token, owner, repoName);

    const eventType = isDispatchTrigger ? trigger : `gitswarm.plugin.${plugin.name}`;

    const execResult = await this.db.query(`
      INSERT INTO gitswarm_plugin_executions (
        repo_id, plugin_id, trigger_event, trigger_payload, status, started_at
      ) VALUES ($1, $2, $3, $4, 'dispatched', NOW())
      RETURNING id
    `, [repoId, plugin.id, trigger, JSON.stringify(this._sanitizePayload(payload))]);

    const executionId = execResult.rows[0].id;

    // Generate execution token for secure reporting
    const executionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(executionToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000);

    await this.db.query(`
      UPDATE gitswarm_plugin_executions
      SET dispatch_token_hash = $2, dispatch_token_expires_at = $3
      WHERE id = $1
    `, [executionId, tokenHash, tokenExpiry]);

    const clientPayload = {
      gitswarm: {
        execution_id: executionId,
        execution_token: executionToken,
        plugin_name: plugin.name,
        plugin_tier: plugin.tier,
        trigger,
      },
      event: this._sanitizePayload(payload),
    };

    try {
      await ghRepo.request(
        'POST',
        `/repos/${owner}/${repoName}/dispatches`,
        { event_type: eventType, client_payload: clientPayload }
      );

      return {
        status: 'dispatched',
        dispatchId: executionId,
        eventType,
        actionsTaken: [{
          action: 'workflow_dispatch',
          event_type: eventType,
          workflow: plugin.dispatch_target,
        }],
      };
    } catch (err) {
      await this.db.query(`
        UPDATE gitswarm_plugin_executions
        SET status = 'failed', error_message = $2, completed_at = NOW()
        WHERE id = $1
      `, [executionId, err.message]);

      return { status: 'dispatch_failed', reason: err.message };
    }
  }

  // ============================================================
  // Helper methods
  // ============================================================

  /**
   * Find enabled plugins that match a trigger event.
   */
  async _matchPlugins(repoId, trigger) {
    const result = await this.db.query(`
      SELECT * FROM gitswarm_repo_plugins
      WHERE repo_id = $1 AND enabled = true AND trigger_event = $2
      ORDER BY priority DESC, created_at ASC
    `, [repoId, trigger]);

    return result.rows;
  }

  /**
   * Evaluate plugin conditions against the event payload.
   * Supports specialized evaluators for gitswarm-specific conditions.
   */
  async _evaluateConditions(plugin, conditions, payload) {
    if (!conditions || Object.keys(conditions).length === 0) return true;

    for (const [key, expected] of Object.entries(conditions)) {
      let result;

      switch (key) {
        case 'files_match':
          result = this._evaluateFilesMatch(expected, payload);
          break;

        case 'max_files_changed':
          result = this._evaluateFileCount(payload, expected);
          break;

        case 'consensus_threshold_met':
          result = expected === true
            ? await this._evaluateConsensus(plugin.repo_id, payload)
            : true;
          break;

        case 'agent_karma':
          result = await this._evaluateKarma(plugin.repo_id, payload, expected);
          break;

        case 'stream_inactive_days': {
          const threshold = typeof expected === 'string'
            ? parseFloat(expected.replace(/[>= ]/g, ''))
            : expected;
          result = this._evaluateInactivity(payload, threshold);
          break;
        }

        case 'stabilization':
          // Currently a pass-through — will be verified at execution time
          // by the workflow or builtin action itself
          result = true;
          break;

        default:
          result = this._evaluateSimpleCondition(payload, key, expected);
      }

      if (!result) return false;
    }

    return true;
  }

  /**
   * Evaluate a simple key/value condition against the payload.
   */
  _evaluateSimpleCondition(payload, key, expected) {
    const actual = this._getNestedValue(payload, key);

    if (typeof expected === 'string' && expected.startsWith('>=')) {
      const threshold = parseFloat(expected.slice(2).trim());
      return typeof actual === 'number' && actual >= threshold;
    } else if (typeof expected === 'string' && expected.startsWith('>')) {
      const threshold = parseFloat(expected.slice(1).trim());
      return typeof actual === 'number' && actual > threshold;
    } else if (typeof expected === 'string' && expected.startsWith('<=')) {
      const threshold = parseFloat(expected.slice(2).trim());
      return typeof actual === 'number' && actual <= threshold;
    } else if (typeof expected === 'string' && expected.startsWith('<')) {
      const threshold = parseFloat(expected.slice(1).trim());
      return typeof actual === 'number' && actual < threshold;
    } else if (Array.isArray(expected)) {
      return expected.includes(actual);
    }
    return expected === actual;
  }

  /**
   * Check if any changed files match the given glob patterns.
   * Uses simple pattern matching (supports ** and * wildcards).
   */
  _evaluateFilesMatch(patterns, payload) {
    const files = this._extractChangedFiles(payload);
    if (files.length === 0) return false;

    const patternsArr = Array.isArray(patterns) ? patterns : [patterns];
    return files.some(file =>
      patternsArr.some(pattern => this._simpleGlobMatch(file, pattern))
    );
  }

  /**
   * Check if file count is within limit.
   */
  _evaluateFileCount(payload, maxFiles) {
    const count = payload.pull_request?.changed_files
      || this._extractChangedFiles(payload).length
      || 0;
    return count <= maxFiles;
  }

  /**
   * Check consensus status for a PR from the gitswarm DB.
   */
  async _evaluateConsensus(repoId, payload) {
    const prNumber = payload.pull_request?.number;
    if (!prNumber) return false;

    try {
      const result = await this.db.query(`
        SELECT s.id FROM gitswarm_streams s
        JOIN gitswarm_repos r ON s.repo_id = r.id
        WHERE r.id = $1 AND s.github_pr_number = $2 AND s.status = 'active'
      `, [repoId, prNumber]);
      if (result.rows.length === 0) return false;

      const streamId = result.rows[0].id;
      const reviews = await this.db.query(`
        SELECT verdict FROM gitswarm_stream_reviews WHERE stream_id = $1
      `, [streamId]);

      const approvals = reviews.rows.filter(r => r.verdict === 'approve').length;
      const rejections = reviews.rows.filter(r => r.verdict === 'request_changes').length;
      const total = approvals + rejections;
      if (total === 0) return false;

      const repo = await this.db.query(`
        SELECT consensus_threshold FROM gitswarm_repos WHERE id = $1
      `, [repoId]);
      const threshold = repo.rows[0]?.consensus_threshold || 0.66;

      return (approvals / total) >= threshold;
    } catch {
      return false;
    }
  }

  /**
   * Check if the triggering agent has sufficient karma.
   */
  async _evaluateKarma(repoId, payload, expected) {
    const threshold = typeof expected === 'string'
      ? parseFloat(expected.replace(/[>= ]/g, ''))
      : expected;

    const agentLogin = payload.sender?.login || payload.pull_request?.user?.login;
    if (!agentLogin) return false;

    try {
      const result = await this.db.query(`
        SELECT a.karma FROM agents a
        JOIN github_user_mappings m ON a.id = m.agent_id
        WHERE m.github_username = $1
      `, [agentLogin]);
      return result.rows.length > 0 && result.rows[0].karma >= threshold;
    } catch {
      return false;
    }
  }

  /**
   * Check if a stream has been inactive for N days.
   */
  _evaluateInactivity(payload, thresholdDays) {
    const updatedAt = payload.stream?.updated_at || payload.updated_at;
    if (!updatedAt) return false;

    const daysSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate >= thresholdDays;
  }

  /**
   * Extract changed files from various payload formats.
   */
  _extractChangedFiles(payload) {
    // PR payload
    if (payload.pull_request?.changed_files_list) {
      return payload.pull_request.changed_files_list;
    }
    // Push payload
    if (payload.commits) {
      const files = new Set();
      for (const commit of payload.commits) {
        for (const f of [...(commit.added || []), ...(commit.modified || []), ...(commit.removed || [])]) {
          files.add(f);
        }
      }
      return [...files];
    }
    return [];
  }

  /**
   * Simple glob pattern matcher (supports * and **).
   */
  _simpleGlobMatch(filepath, pattern) {
    const regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{GLOBSTAR}}/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${regex}$`).test(filepath);
  }

  /**
   * Get a nested value from an object using dot notation.
   */
  _getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Resolve repo UUID from a webhook payload.
   */
  async _resolveRepoId(payload) {
    const repository = payload.repository;
    if (!repository) return null;

    const result = await this.db.query(`
      SELECT id FROM gitswarm_repos
      WHERE github_repo_id = $1 AND status = 'active'
    `, [repository.id]);

    return result.rows[0]?.id || null;
  }

  /**
   * Check if plugins are enabled for a repo.
   */
  async _pluginsEnabled(repoId) {
    const result = await this.db.query(`
      SELECT plugins_enabled FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    return result.rows[0]?.plugins_enabled === true;
  }

  /**
   * Resolve labels from plugin config.
   * Respects the max_label_additions budget from safe_outputs.
   */
  _resolveLabels(plugin, payload) {
    const allowedLabels = plugin.safe_outputs?.allowed_labels || [];
    const maxLabels = plugin.safe_outputs?.max_label_additions || 3;
    if (allowedLabels.length > 0) return allowedLabels.slice(0, maxLabels);
    return [];
  }

  /**
   * Add labels to an issue or PR via GitHub API.
   */
  async _addLabels(repoId, payload, labels) {
    const client = await this._getGitHubRepoClient(repoId);
    if (!client) return;

    const issueNumber = payload.issue?.number || payload.pull_request?.number;
    if (!issueNumber) return;

    const { ghRepo, owner, repoName } = client;
    await ghRepo.request(
      'POST',
      `/repos/${owner}/${repoName}/issues/${issueNumber}/labels`,
      { labels }
    );
  }

  /**
   * Add a comment to an issue or PR.
   */
  async _addComment(repoId, payload, body) {
    const client = await this._getGitHubRepoClient(repoId);
    if (!client) return;

    const issueNumber = payload.issue?.number || payload.pull_request?.number;
    if (!issueNumber) return;

    const { ghRepo } = client;
    await ghRepo.addPullRequestComment(issueNumber, body);
  }

  /**
   * Close completed tasks linked to issues in this repo.
   */
  async _closeCompletedTasks(repoId) {
    const result = await this.db.query(`
      UPDATE gitswarm_tasks SET status = 'completed', updated_at = NOW()
      WHERE repo_id = $1 AND status = 'submitted'
      RETURNING id
    `, [repoId]);

    return result.rows.length;
  }

  /**
   * Get a GitHub API client for a repo.
   */
  async _getGitHubRepoClient(repoId) {
    const repo = await this.db.query(`
      SELECT r.github_full_name, o.github_installation_id
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) return null;

    const { github_full_name, github_installation_id } = repo.rows[0];
    if (!github_installation_id) return null;

    const [owner, repoName] = github_full_name.split('/');
    const token = await githubApp.getInstallationToken(github_installation_id);
    return { ghRepo: new GitHubRepo(token, owner, repoName), owner, repoName };
  }

  /**
   * Get repo config from gitswarm_repos.
   */
  async _getRepoConfig(repoId) {
    const result = await this.db.query(`
      SELECT buffer_branch, promote_target, auto_promote_on_green,
             auto_revert_on_red, stabilize_command, consensus_threshold
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);
    return result.rows[0] || {};
  }

  /**
   * Promote buffer branch to main via GitHub merge API.
   * This is a Tier 1 deterministic action.
   */
  async _promoteBufferToMain(repoId) {
    try {
      const config = await this._getRepoConfig(repoId);
      const bufferBranch = config.buffer_branch || 'buffer';
      const target = config.promote_target || 'main';

      const client = await this._getGitHubRepoClient(repoId);
      if (!client) return { success: false, reason: 'no_github_client' };

      const { ghRepo, owner, repoName } = client;

      const result = await ghRepo.request(
        'POST',
        `/repos/${owner}/${repoName}/merges`,
        {
          base: target,
          head: bufferBranch,
          commit_message: `Promote ${bufferBranch} to ${target} via gitswarm auto-promote`,
        }
      );

      return {
        success: true,
        from: bufferBranch,
        to: target,
        sha: result.sha,
      };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  /**
   * Notify contributors on a PR/issue by posting a comment.
   */
  async _notifyContributors(repoId, payload, message) {
    const issueNumber = payload.issue?.number || payload.pull_request?.number;
    if (!issueNumber) return false;

    try {
      await this._addComment(repoId, payload, message);
      return true;
    } catch (err) {
      console.error(`notify_contributors failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Notify a stream owner about their stream (e.g., stale stream reminder).
   * Posts a comment on the PR linked to the stream.
   */
  async _notifyStreamOwner(repoId, payload, message) {
    const streamId = payload.stream?.id || payload.stream_id;
    if (!streamId) return false;

    try {
      const stream = await this.db.query(`
        SELECT github_pr_number FROM gitswarm_streams WHERE id = $1
      `, [streamId]);

      if (stream.rows.length === 0 || !stream.rows[0].github_pr_number) return false;

      const prNumber = stream.rows[0].github_pr_number;
      const client = await this._getGitHubRepoClient(repoId);
      if (!client) return false;

      const { ghRepo } = client;
      await ghRepo.addPullRequestComment(prNumber, message);
      return true;
    } catch (err) {
      console.error(`notify_stream_owner failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Sanitize payload for dispatch (remove sensitive data, reduce size).
   */
  _sanitizePayload(payload) {
    const sanitized = { ...payload };

    // Remove installation tokens and sensitive headers
    delete sanitized.installation;

    // Limit large fields
    if (sanitized.issue?.body && sanitized.issue.body.length > 5000) {
      sanitized.issue = { ...sanitized.issue, body: sanitized.issue.body.slice(0, 5000) + '...' };
    }
    if (sanitized.pull_request?.body && sanitized.pull_request.body.length > 5000) {
      sanitized.pull_request = {
        ...sanitized.pull_request,
        body: sanitized.pull_request.body.slice(0, 5000) + '...',
      };
    }

    return sanitized;
  }

  /**
   * Record a plugin execution in the audit log.
   */
  async _recordExecution(plugin, trigger, payload, status, actionsTaken, safeOutputSummary, errorMessage = null) {
    try {
      await this.db.query(`
        INSERT INTO gitswarm_plugin_executions (
          repo_id, plugin_id, trigger_event, trigger_payload,
          status, actions_taken, safe_output_usage, error_message,
          started_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      `, [
        plugin.repo_id,
        plugin.id,
        trigger,
        JSON.stringify(this._sanitizePayload(payload)),
        status,
        JSON.stringify(actionsTaken),
        JSON.stringify(safeOutputSummary),
        errorMessage,
      ]);
    } catch (err) {
      console.error('Failed to record plugin execution:', err.message);
    }
  }

  /**
   * Post-hoc audit: correlate incoming webhook actions to recent plugin executions.
   * Called from the webhook handler when mutations occur (labels added, comments posted, etc.)
   * that might have been produced by a dispatched AI workflow.
   *
   * If over-budget, logs a warning activity event.
   */
  async auditWorkflowAction(repoId, actionType, payload) {
    try {
      // Find recent dispatched/running executions for this repo
      const recent = await this.db.query(`
        SELECT e.id, e.plugin_id, e.safe_output_usage, e.actions_taken,
               p.safe_outputs as plugin_safe_outputs
        FROM gitswarm_plugin_executions e
        JOIN gitswarm_repo_plugins p ON e.plugin_id = p.id
        WHERE e.repo_id = $1 AND e.status IN ('dispatched', 'running')
          AND e.started_at > NOW() - INTERVAL '10 minutes'
        ORDER BY e.started_at DESC
      `, [repoId]);

      if (recent.rows.length === 0) return;

      // Attribute to most recent matching execution
      const exec = recent.rows[0];
      const currentActions = exec.actions_taken || [];
      currentActions.push({
        action: actionType,
        detected_at: new Date().toISOString(),
        source: 'webhook_audit',
      });

      await this.db.query(`
        UPDATE gitswarm_plugin_executions
        SET actions_taken = $2
        WHERE id = $1
      `, [exec.id, JSON.stringify(currentActions)]);

      // Check if over budget by mapping action names to budget keys
      const pluginLimits = exec.plugin_safe_outputs || {};
      const budgetUsage = {};

      for (const act of currentActions) {
        const budgetKey = this.safeOutputs.getActionBudgetKey?.(act.action);
        if (budgetKey) {
          budgetUsage[budgetKey] = (budgetUsage[budgetKey] || 0) + 1;
        }
      }

      // Log warning if any budget is exceeded
      if (this.activityService) {
        for (const [budgetKey, used] of Object.entries(budgetUsage)) {
          const limit = pluginLimits[budgetKey];
          if (limit !== undefined && used > limit) {
            this.activityService.logActivity({
              event_type: 'plugin_over_budget',
              target_type: 'plugin_execution',
              target_id: exec.id,
              metadata: {
                repo_id: repoId,
                action_type: actionType,
                budget_key: budgetKey,
                used,
                limit,
              },
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('auditWorkflowAction failed:', err.message);
    }
  }

  /**
   * Verify an execution token for the report endpoint.
   * Returns true if the token is valid and not expired.
   */
  async verifyExecutionToken(executionId, token) {
    if (!token) return false;

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await this.db.query(`
      SELECT id FROM gitswarm_plugin_executions
      WHERE id = $1 AND dispatch_token_hash = $2
        AND dispatch_token_expires_at > NOW()
    `, [executionId, tokenHash]);

    return result.rows.length > 0;
  }

  /**
   * Resolve a workflow completion from a workflow_run webhook event.
   * Matches the workflow name to dispatched execution records and
   * updates their status based on the workflow conclusion.
   */
  async resolveWorkflowCompletion(repoId, workflowName, conclusion) {
    const status = conclusion === 'success' ? 'completed'
      : conclusion === 'cancelled' ? 'cancelled'
      : 'failed';

    const result = await this.db.query(`
      UPDATE gitswarm_plugin_executions SET
        status = $3,
        completed_at = NOW()
      WHERE id = (
        SELECT e.id FROM gitswarm_plugin_executions e
        JOIN gitswarm_repo_plugins p ON e.plugin_id = p.id
        WHERE e.repo_id = $1 AND e.status = 'dispatched'
          AND (p.workflow_file ILIKE $2 OR p.dispatch_target ILIKE $2)
          AND e.started_at > NOW() - INTERVAL '30 minutes'
        ORDER BY e.started_at DESC LIMIT 1
      )
      RETURNING id
    `, [repoId, `%${workflowName}%`, status]);

    return result.rows[0]?.id || null;
  }

  /**
   * Report execution result from GitHub Actions callback.
   * Called when a dispatched plugin completes and reports back.
   */
  async reportExecutionResult(executionId, result) {
    const { status, actions_taken, safe_output_usage, error_message } = result;

    await this.db.query(`
      UPDATE gitswarm_plugin_executions SET
        status = $2,
        actions_taken = $3,
        safe_output_usage = $4,
        error_message = $5,
        completed_at = NOW()
      WHERE id = $1
    `, [
      executionId,
      status,
      JSON.stringify(actions_taken || []),
      JSON.stringify(safe_output_usage || {}),
      error_message,
    ]);

    return { updated: true };
  }
}

export default PluginEngine;
