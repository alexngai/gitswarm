/**
 * Plugin Event Dispatcher
 *
 * The central event bus for repo-level plugin agents. Hooks into
 * GitSwarm's activity system and dispatches events to subscribed
 * plugin installations.
 *
 * Architecture:
 *   ActivityService.logActivity()
 *     → PluginDispatcher.dispatch(repoId, eventType, payload)
 *       → For each subscribed installation:
 *         → Validate rate limits
 *         → Create event record
 *         → Deliver via webhook / builtin / github_action
 *         → Process response actions
 *         → Execute validated actions
 *
 * The dispatcher is intentionally fire-and-forget on the hot path.
 * Event delivery happens asynchronously. Failures are retried
 * with exponential backoff.
 */

import { query } from '../config/database.js';
import crypto from 'crypto';

// Retry delays in milliseconds (exponential backoff)
const RETRY_DELAYS = [5000, 30000, 120000]; // 5s, 30s, 2min

class PluginDispatcher {
  constructor(db, { registryService, actionExecutor, webhookDelivery } = {}) {
    this.db = db || { query };
    this.registryService = registryService;
    this.actionExecutor = actionExecutor;
    this.webhookDelivery = webhookDelivery;

    // Builtin plugin handlers (registered at startup)
    this._builtinHandlers = new Map();
  }

  /**
   * Register a builtin plugin handler.
   * Builtin plugins run in-process and don't need webhook delivery.
   */
  registerBuiltinHandler(pluginSlug, handler) {
    this._builtinHandlers.set(pluginSlug, handler);
  }

  /**
   * Dispatch an event to all subscribed plugins for a repo.
   *
   * This is the main entry point. Called by ActivityService or
   * directly by services that produce events.
   *
   * @param {string} repoId - The repo where the event occurred
   * @param {string} eventType - Event type (e.g. 'consensus_reached')
   * @param {object} payload - Event data (event-specific)
   * @returns {Promise<{dispatched: number, errors: number}>}
   */
  async dispatch(repoId, eventType, payload = {}) {
    if (!this.registryService) return { dispatched: 0, errors: 0 };

    // Find all installations subscribed to this event
    const installations = await this.registryService.getSubscribedInstallations(
      repoId,
      eventType
    );

    if (installations.length === 0) {
      return { dispatched: 0, errors: 0 };
    }

    let dispatched = 0;
    let errors = 0;

    // Dispatch to each installation (ordered by priority)
    for (const installation of installations) {
      try {
        // Check rate limit
        const withinLimit = await this._checkRateLimit(installation.id, installation.rate_limit_per_hour);
        if (!withinLimit) {
          await this._createEventRecord(installation, repoId, eventType, payload, 'skipped');
          continue;
        }

        // Create pending event record
        const eventRecord = await this._createEventRecord(
          installation, repoId, eventType, payload, 'pending'
        );

        // Dispatch based on plugin type
        await this._deliverEvent(installation, eventRecord, eventType, payload);
        dispatched++;
      } catch (error) {
        errors++;
        console.error(
          `Plugin dispatch error [${installation.plugin_name}@${repoId}]:`,
          error.message
        );
      }
    }

    return { dispatched, errors };
  }

  /**
   * Deliver an event to a specific installation.
   */
  async _deliverEvent(installation, eventRecord, eventType, payload) {
    const startTime = Date.now();

    try {
      let response;

      switch (installation.plugin_type) {
        case 'builtin':
          response = await this._deliverBuiltin(installation, eventType, payload);
          break;

        case 'webhook':
          response = await this._deliverWebhook(installation, eventRecord, eventType, payload);
          break;

        case 'github_action':
          response = await this._deliverGitHubAction(installation, eventType, payload);
          break;

        default:
          throw new Error(`Unknown plugin type: ${installation.plugin_type}`);
      }

      const durationMs = Date.now() - startTime;

      // Update event record with success
      await this.db.query(`
        UPDATE gitswarm_plugin_events
        SET status = 'delivered',
            attempts = attempts + 1,
            response_status = $2,
            response_body = $3,
            actions_taken = $4,
            delivered_at = NOW(),
            duration_ms = $5
        WHERE id = $1
      `, [
        eventRecord.id,
        response.status || 200,
        JSON.stringify(response.body || {}),
        JSON.stringify(response.actions || []),
        durationMs,
      ]);

      // Update installation stats
      await this.db.query(`
        UPDATE gitswarm_plugin_installations
        SET events_received = events_received + 1,
            events_succeeded = events_succeeded + 1,
            last_event_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `, [installation.id]);

      // Process any actions the plugin wants to take
      if (response.actions && response.actions.length > 0) {
        await this._processActions(installation, eventRecord, response.actions);
      }

    } catch (error) {
      const durationMs = Date.now() - startTime;
      const attempts = (eventRecord.attempts || 0) + 1;
      const maxAttempts = installation.max_retries || 3;

      // Determine if we should retry
      const shouldRetry = attempts < maxAttempts;
      const nextRetry = shouldRetry
        ? new Date(Date.now() + (RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1]))
        : null;

      // Update event record with failure
      await this.db.query(`
        UPDATE gitswarm_plugin_events
        SET status = $2,
            attempts = $3,
            next_retry_at = $4,
            response_status = $5,
            response_body = $6,
            duration_ms = $7
        WHERE id = $1
      `, [
        eventRecord.id,
        shouldRetry ? 'pending' : 'failed',
        attempts,
        nextRetry,
        error.statusCode || 500,
        JSON.stringify({ error: error.message }),
        durationMs,
      ]);

      // Update installation stats
      await this.db.query(`
        UPDATE gitswarm_plugin_installations
        SET events_received = events_received + 1,
            events_failed = events_failed + 1,
            last_error = $2,
            last_error_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `, [installation.id, error.message]);

      // If too many failures, auto-disable
      await this._checkHealthAndDisable(installation.id);
    }
  }

  /**
   * Deliver to a builtin plugin (runs in-process).
   */
  async _deliverBuiltin(installation, eventType, payload) {
    const handler = this._builtinHandlers.get(installation.plugin_slug);
    if (!handler) {
      throw new Error(`No builtin handler registered for plugin: ${installation.plugin_slug}`);
    }

    const result = await handler({
      event: eventType,
      payload,
      installation,
      config: installation.config,
    });

    return {
      status: 200,
      body: result?.body || {},
      actions: result?.actions || [],
    };
  }

  /**
   * Deliver to a webhook plugin (HTTP POST).
   */
  async _deliverWebhook(installation, eventRecord, eventType, payload) {
    if (!this.webhookDelivery) {
      throw new Error('Webhook delivery service not configured');
    }

    return await this.webhookDelivery.deliver({
      url: installation.webhook_url,
      secretHash: installation.webhook_secret_hash,
      eventId: eventRecord.id,
      eventType,
      payload: {
        event: eventType,
        installation_id: installation.id,
        repo_id: installation.repo_id,
        config: installation.config,
        data: payload,
      },
    });
  }

  /**
   * Deliver to a GitHub Action plugin (workflow dispatch).
   */
  async _deliverGitHubAction(installation, eventType, payload) {
    // This would integrate with GitHub's workflow_dispatch API
    // via the GitSwarm GitHub App's installation token.
    // For now, return a placeholder — the actual implementation
    // would use the github.js service to trigger the workflow.
    return {
      status: 202,
      body: {
        message: 'GitHub Action dispatch queued',
        repo: installation.github_action_repo,
        workflow: installation.github_action_workflow,
      },
      actions: [],
    };
  }

  /**
   * Process actions requested by a plugin in its response.
   *
   * Each action is validated against the installation's granted
   * capabilities before execution.
   */
  async _processActions(installation, eventRecord, actions) {
    for (const action of actions) {
      // Map action type to required capability
      const requiredCap = this._actionToCapability(action.action);
      if (!requiredCap) {
        console.warn(`Unknown plugin action: ${action.action}`);
        continue;
      }

      // Check if installation has the required capability
      const caps = installation.granted_capabilities || [];
      const hasCapability = caps.includes(requiredCap);

      // Create action record
      const actionResult = await this.db.query(`
        INSERT INTO gitswarm_plugin_actions (
          event_id, installation_id, repo_id,
          action_type, target_type, target_id, action_data,
          required_capability,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        eventRecord.id, installation.id, installation.repo_id,
        action.action, action.target_type, action.target_id,
        JSON.stringify(action.data || {}),
        requiredCap,
        hasCapability ? 'approved' : 'rejected',
      ]);

      const actionRecord = actionResult.rows[0];

      if (!hasCapability) {
        await this.db.query(`
          UPDATE gitswarm_plugin_actions
          SET rejection_reason = $2
          WHERE id = $1
        `, [actionRecord.id, `Missing capability: ${requiredCap}`]);
        continue;
      }

      // Execute the action
      if (this.actionExecutor) {
        try {
          const result = await this.actionExecutor.execute(actionRecord);
          await this.db.query(`
            UPDATE gitswarm_plugin_actions
            SET status = 'executed', executed_at = NOW(), execution_result = $2
            WHERE id = $1
          `, [actionRecord.id, JSON.stringify(result)]);
        } catch (error) {
          await this.db.query(`
            UPDATE gitswarm_plugin_actions
            SET status = 'failed', execution_result = $2
            WHERE id = $1
          `, [actionRecord.id, JSON.stringify({ error: error.message })]);
        }
      }
    }
  }

  // ============================================================
  // Retry processing
  // ============================================================

  /**
   * Process pending retries. Called periodically by a scheduler.
   */
  async processRetries() {
    const pending = await this.db.query(`
      SELECT pe.*, pi.plugin_type, pi.config, pi.granted_capabilities,
             p.webhook_url, p.webhook_secret_hash, p.slug as plugin_slug,
             p.github_action_repo, p.github_action_workflow,
             pi.repo_id, pi.max_retries, pi.rate_limit_per_hour
      FROM gitswarm_plugin_events pe
      JOIN gitswarm_plugin_installations pi ON pe.installation_id = pi.id
      JOIN gitswarm_plugins p ON pe.plugin_id = p.id
      WHERE pe.status = 'pending'
        AND pe.next_retry_at IS NOT NULL
        AND pe.next_retry_at <= NOW()
        AND pi.enabled = TRUE
        AND pi.status = 'active'
      ORDER BY pe.next_retry_at ASC
      LIMIT 50
    `);

    for (const event of pending.rows) {
      try {
        await this._deliverEvent(
          {
            id: event.installation_id,
            plugin_type: event.plugin_type,
            plugin_slug: event.plugin_slug,
            config: event.config,
            granted_capabilities: event.granted_capabilities,
            webhook_url: event.webhook_url,
            webhook_secret_hash: event.webhook_secret_hash,
            github_action_repo: event.github_action_repo,
            github_action_workflow: event.github_action_workflow,
            repo_id: event.repo_id,
            max_retries: event.max_retries,
            rate_limit_per_hour: event.rate_limit_per_hour,
          },
          event,
          event.event_type,
          event.payload
        );
      } catch (error) {
        console.error(`Retry failed for event ${event.id}:`, error.message);
      }
    }

    return pending.rows.length;
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  async _createEventRecord(installation, repoId, eventType, payload, status) {
    const result = await this.db.query(`
      INSERT INTO gitswarm_plugin_events (
        installation_id, repo_id, plugin_id,
        event_type, payload, status, max_attempts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      installation.id, repoId, installation.plugin_id,
      eventType, JSON.stringify(payload), status,
      installation.max_retries || 3,
    ]);

    return result.rows[0];
  }

  async _checkRateLimit(installationId, limitPerHour) {
    if (!limitPerHour) return true;

    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM gitswarm_plugin_events
      WHERE installation_id = $1
        AND created_at > NOW() - INTERVAL '1 hour'
    `, [installationId]);

    return parseInt(result.rows[0].count) < limitPerHour;
  }

  async _checkHealthAndDisable(installationId) {
    // Auto-disable if more than 10 consecutive failures
    const result = await this.db.query(`
      SELECT COUNT(*) as fail_count FROM (
        SELECT status FROM gitswarm_plugin_events
        WHERE installation_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      ) recent
      WHERE recent.status = 'failed'
    `, [installationId]);

    if (parseInt(result.rows[0].fail_count) >= 10) {
      await this.db.query(`
        UPDATE gitswarm_plugin_installations
        SET status = 'error', enabled = FALSE,
            last_error = 'Auto-disabled after 10 consecutive failures',
            updated_at = NOW()
        WHERE id = $1
      `, [installationId]);
    }
  }

  /**
   * Map a plugin action type to the capability it requires.
   */
  _actionToCapability(actionType) {
    const mapping = {
      // Read actions (usually don't need explicit capability check,
      // but we track them for audit)
      'read_stream': 'read:streams',
      'read_reviews': 'read:reviews',
      'read_consensus': 'read:consensus',

      // Write actions
      'add_review': 'write:reviews',
      'post_comment': 'write:comments',
      'add_label': 'write:labels',
      'remove_label': 'write:labels',
      'create_task': 'write:tasks',
      'update_task': 'write:tasks',
      'update_metadata': 'write:metadata',

      // High-impact actions
      'approve_merge': 'action:merge',
      'trigger_merge': 'action:merge',
      'trigger_promotion': 'action:promote',
      'trigger_stabilization': 'action:stabilize',
      'assign_agent': 'action:assign',
      'close_issue': 'action:close',
      'abandon_stream': 'action:close',
      'revert_stream': 'action:revert',
      'create_pr': 'action:github_pr',
      'update_pr': 'action:github_pr',
      'approve_pr': 'action:approve_pr',
    };

    return mapping[actionType] || null;
  }
}

export default PluginDispatcher;
