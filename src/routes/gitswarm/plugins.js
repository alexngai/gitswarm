/**
 * Plugin Routes — API for managing repo-level plugins
 *
 * Endpoints:
 *  GET    /gitswarm/repos/:id/plugins          - List plugins for a repo
 *  POST   /gitswarm/repos/:id/plugins          - Install a plugin
 *  PATCH  /gitswarm/repos/:id/plugins/:name    - Update plugin config
 *  DELETE /gitswarm/repos/:id/plugins/:name    - Remove a plugin
 *  POST   /gitswarm/repos/:id/plugins/sync     - Sync from .gitswarm/
 *  GET    /gitswarm/repos/:id/plugins/executions - Plugin execution log
 *  POST   /gitswarm/repos/:id/plugins/executions/:execId/report - Report dispatch result
 */

import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

const permissionService = new GitSwarmPermissionService();

export async function pluginRoutes(app, options = {}) {
  const { activityService, pluginEngine, configSyncService } = options;
  const rateLimit = createRateLimiter('default');
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  // ============================================================
  // List plugins for a repo
  // ============================================================
  app.get('/gitswarm/repos/:id/plugins', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'No read access' });
    }

    const plugins = await query(`
      SELECT
        p.id, p.name, p.enabled, p.tier, p.trigger_event, p.conditions,
        p.actions, p.safe_outputs, p.config, p.execution_model,
        p.priority, p.source, p.created_at, p.updated_at,
        (
          SELECT COUNT(*) FROM gitswarm_plugin_executions e
          WHERE e.plugin_id = p.id AND e.created_at > NOW() - INTERVAL '24 hours'
        ) as executions_24h,
        (
          SELECT status FROM gitswarm_plugin_executions e
          WHERE e.plugin_id = p.id
          ORDER BY e.created_at DESC LIMIT 1
        ) as last_execution_status
      FROM gitswarm_repo_plugins p
      WHERE p.repo_id = $1
      ORDER BY p.priority DESC, p.name
    `, [id]);

    // Get repo-level config info
    const configResult = await query(`
      SELECT plugins_enabled, last_synced_at, sync_error
      FROM gitswarm_repo_config
      WHERE repo_id = $1
    `, [id]);

    const config = configResult.rows[0] || { plugins_enabled: false };

    return {
      plugins_enabled: config.plugins_enabled,
      last_synced_at: config.last_synced_at,
      sync_error: config.sync_error,
      plugins: plugins.rows,
    };
  });

  // ============================================================
  // Install a plugin via API (not from .gitswarm/ config)
  // ============================================================
  app.post('/gitswarm/repos/:id/plugins', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'trigger_event'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9-]*$' },
          enabled: { type: 'boolean' },
          trigger_event: { type: 'string', minLength: 1, maxLength: 100 },
          conditions: { type: 'object' },
          actions: { type: 'array' },
          safe_outputs: { type: 'object' },
          config: { type: 'object' },
          execution_model: { type: 'string', enum: ['builtin', 'dispatch', 'webhook'] },
          dispatch_target: { type: 'string' },
          priority: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only admins can install plugins' });
    }

    const {
      name, enabled = true, trigger_event, conditions = {},
      actions = [], safe_outputs = {}, config = {},
      execution_model = 'dispatch', dispatch_target, priority = 0,
    } = request.body;

    // Infer tier
    const tier = config.engine || config.model ? 'ai'
      : trigger_event.startsWith('gitswarm.consensus') ? 'governance'
      : 'automation';

    try {
      const result = await query(`
        INSERT INTO gitswarm_repo_plugins (
          repo_id, name, enabled, tier, trigger_event, conditions,
          actions, safe_outputs, config, execution_model,
          dispatch_target, priority, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'api')
        RETURNING *
      `, [
        id, name, enabled, tier, trigger_event,
        JSON.stringify(conditions), JSON.stringify(actions),
        JSON.stringify(safe_outputs), JSON.stringify(config),
        execution_model, dispatch_target || `gitswarm.plugin.${name}`, priority,
      ]);

      // Enable plugins on the repo if not already
      await query(`
        UPDATE gitswarm_repos SET plugins_enabled = true, updated_at = NOW()
        WHERE id = $1 AND plugins_enabled = false
      `, [id]);

      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'plugin_installed',
          target_type: 'plugin',
          target_id: result.rows[0].id,
          metadata: { repo_id: id, plugin_name: name, tier },
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ plugin: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Conflict', message: 'Plugin with this name already exists' });
      }
      throw err;
    }
  });

  // ============================================================
  // Update a plugin
  // ============================================================
  app.patch('/gitswarm/repos/:id/plugins/:name', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          trigger_event: { type: 'string' },
          conditions: { type: 'object' },
          actions: { type: 'array' },
          safe_outputs: { type: 'object' },
          config: { type: 'object' },
          execution_model: { type: 'string', enum: ['builtin', 'dispatch', 'webhook'] },
          dispatch_target: { type: 'string' },
          priority: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id, name } = request.params;

    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only admins can update plugins' });
    }

    const allowedFields = [
      'enabled', 'trigger_event', 'conditions', 'actions',
      'safe_outputs', 'config', 'execution_model', 'dispatch_target', 'priority',
    ];
    const jsonFields = ['conditions', 'actions', 'safe_outputs', 'config'];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        const value = jsonFields.includes(field)
          ? JSON.stringify(request.body[field])
          : request.body[field];
        updates.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'Bad Request', message: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    values.push(id, name);

    const result = await query(`
      UPDATE gitswarm_repo_plugins SET ${updates.join(', ')}
      WHERE repo_id = $${paramIndex} AND name = $${paramIndex + 1}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Plugin not found' });
    }

    return { plugin: result.rows[0] };
  });

  // ============================================================
  // Remove a plugin
  // ============================================================
  app.delete('/gitswarm/repos/:id/plugins/:name', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { id, name } = request.params;

    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only admins can remove plugins' });
    }

    const result = await query(`
      DELETE FROM gitswarm_repo_plugins
      WHERE repo_id = $1 AND name = $2 AND source = 'api'
      RETURNING id, name
    `, [id, name]);

    if (result.rows.length === 0) {
      // Check if it's a config-sourced plugin (can't delete, only disable)
      const configPlugin = await query(`
        SELECT id FROM gitswarm_repo_plugins
        WHERE repo_id = $1 AND name = $2 AND source = 'config'
      `, [id, name]);

      if (configPlugin.rows.length > 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Config-sourced plugins cannot be deleted. Disable via .gitswarm/plugins.yml or use PATCH to set enabled=false.',
        });
      }

      return reply.status(404).send({ error: 'Not Found', message: 'Plugin not found' });
    }

    return { success: true, message: `Plugin ${name} removed` };
  });

  // ============================================================
  // Sync plugins from .gitswarm/ config
  // ============================================================
  app.post('/gitswarm/repos/:id/plugins/sync', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { id } = request.params;

    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only admins can sync plugin config' });
    }

    if (!configSyncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Config sync not available' });
    }

    try {
      const result = await configSyncService.syncRepoConfig(id);

      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'plugin_config_synced',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: result,
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (err) {
      return reply.status(500).send({ error: 'Sync Failed', message: err.message });
    }
  });

  // ============================================================
  // Plugin execution log
  // ============================================================
  app.get('/gitswarm/repos/:id/plugins/executions', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;
    const pluginName = request.query.plugin;
    const status = request.query.status;

    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'No read access' });
    }

    let whereClause = 'e.repo_id = $1';
    const params = [id];
    let paramIndex = 2;

    if (pluginName) {
      whereClause += ` AND p.name = $${paramIndex++}`;
      params.push(pluginName);
    }
    if (status) {
      whereClause += ` AND e.status = $${paramIndex++}`;
      params.push(status);
    }

    params.push(limit, offset);

    const result = await query(`
      SELECT
        e.id, e.trigger_event, e.status, e.actions_taken,
        e.safe_output_usage, e.error_message, e.dispatch_id,
        e.started_at, e.completed_at, e.created_at,
        p.name as plugin_name, p.tier as plugin_tier
      FROM gitswarm_plugin_executions e
      JOIN gitswarm_repo_plugins p ON e.plugin_id = p.id
      WHERE ${whereClause}
      ORDER BY e.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    return { executions: result.rows };
  });

  // ============================================================
  // Report execution result (callback from GitHub Actions)
  // Supports two auth modes:
  //   1. Execution token (X-GitSwarm-Execution-Token header) — short-lived, per-execution
  //   2. Standard Bearer token (via authenticate middleware) — long-lived agent key
  // ============================================================
  app.post('/gitswarm/repos/:id/plugins/executions/:execId/report', {
    preHandler: [rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['completed', 'failed'] },
          actions_taken: { type: 'array' },
          safe_output_usage: { type: 'object' },
          error_message: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id, execId } = request.params;

    // Try execution token auth first
    const execToken = request.headers['x-gitswarm-execution-token'];
    let authenticated = false;

    if (execToken && pluginEngine) {
      authenticated = await pluginEngine.verifyExecutionToken(execId, execToken);
    }

    // Fall back to standard Bearer auth
    if (!authenticated) {
      try {
        await authenticate(request, reply);
        if (reply.sent) return; // authenticate may have already sent 401
        authenticated = true;
      } catch {
        if (reply.sent) return;
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Valid execution token or Bearer token required',
        });
      }
    }

    // Verify the execution belongs to this repo
    const execResult = await query(`
      SELECT id, plugin_id FROM gitswarm_plugin_executions
      WHERE id = $1 AND repo_id = $2 AND status = 'dispatched'
    `, [execId, id]);

    if (execResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Execution not found or not in dispatched state',
      });
    }

    if (!pluginEngine) {
      return reply.status(503).send({ error: 'Service Unavailable' });
    }

    const result = await pluginEngine.reportExecutionResult(execId, request.body);
    return result;
  });
}
