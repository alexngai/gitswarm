/**
 * Plugin Management Routes
 *
 * API endpoints for repo-level plugin agent federation:
 * - Plugin registry (browse, register, manage plugins)
 * - Installation management (install, configure, uninstall per-repo)
 * - Event history and action audit log
 */

import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import PluginRegistryService from '../../services/plugin-registry.js';

const registryService = new PluginRegistryService();
const rateLimitRead = createRateLimiter('gitswarm_read');
const rateLimitWrite = createRateLimiter('gitswarm_write');

export async function pluginRoutes(app, options = {}) {
  const { activityService, pluginDispatcher } = options;

  // ============================================================
  // Plugin Registry
  // ============================================================

  // List available plugins
  app.get('/gitswarm/plugins', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const {
      status = 'active',
      plugin_type: pluginType,
      author_id: authorId,
      limit = 50,
      offset = 0,
    } = request.query;

    const plugins = await registryService.listPlugins({
      status,
      pluginType,
      authorId,
      limit: Math.min(parseInt(limit), 100),
      offset: parseInt(offset),
    });

    return { plugins };
  });

  // Get plugin details
  app.get('/gitswarm/plugins/:idOrSlug', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const plugin = await registryService.getPlugin(request.params.idOrSlug);
    if (!plugin) {
      return reply.status(404).send({ error: 'Plugin not found' });
    }
    return { plugin };
  });

  // Register a new plugin
  app.post('/gitswarm/plugins', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const agentId = request.agent?.id;
    if (!agentId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    try {
      const plugin = await registryService.registerPlugin({
        ...request.body,
        authorId: agentId,
      });

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'plugin_registered',
          target_type: 'plugin',
          target_id: plugin.id,
          metadata: { name: plugin.name, slug: plugin.slug, plugin_type: plugin.plugin_type },
        });
      }

      return reply.status(201).send({ plugin });
    } catch (error) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Update a plugin (author only)
  app.patch('/gitswarm/plugins/:id', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const agentId = request.agent?.id;
    const plugin = await registryService.getPlugin(request.params.id);

    if (!plugin) {
      return reply.status(404).send({ error: 'Plugin not found' });
    }

    if (plugin.author_id !== agentId) {
      return reply.status(403).send({ error: 'Only the plugin author can update it' });
    }

    const {
      description, webhook_url, capabilities,
      subscribed_events, config_schema, default_config,
      homepage_url, documentation_url, version,
    } = request.body;

    const updates = [];
    const params = [];
    let paramIdx = 0;

    const fields = {
      description, webhook_url, version,
      homepage_url, documentation_url,
    };

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        paramIdx++;
        updates.push(`${key} = $${paramIdx}`);
        params.push(value);
      }
    }

    const jsonFields = { capabilities, subscribed_events, config_schema, default_config };
    for (const [key, value] of Object.entries(jsonFields)) {
      if (value !== undefined) {
        paramIdx++;
        updates.push(`${key} = $${paramIdx}`);
        params.push(JSON.stringify(value));
      }
    }

    if (updates.length === 0) {
      return { plugin };
    }

    paramIdx++;
    params.push(plugin.id);

    const result = await query(`
      UPDATE gitswarm_plugins SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIdx}
      RETURNING *
    `, params);

    return { plugin: result.rows[0] };
  });

  // ============================================================
  // Plugin Installations (per-repo)
  // ============================================================

  // List plugins installed on a repo
  app.get('/gitswarm/repos/:repoId/plugins', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = request.params;
    const includeDisabled = request.query.include_disabled === 'true';

    const installations = await registryService.listRepoInstallations(
      repoId,
      { includeDisabled }
    );

    return { installations };
  });

  // Install a plugin on a repo
  app.post('/gitswarm/repos/:repoId/plugins', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const agentId = request.agent?.id;
    const { repoId } = request.params;

    if (!agentId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    // Verify the installer is a maintainer/owner
    const maintainer = await query(`
      SELECT role FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length === 0) {
      return reply.status(403).send({ error: 'Only maintainers can install plugins' });
    }

    try {
      const {
        plugin_id,
        granted_capabilities = [],
        config = {},
        subscribed_events,
        priority,
      } = request.body;

      const installation = await registryService.installPlugin({
        repoId,
        pluginId: plugin_id,
        installedBy: agentId,
        grantedCapabilities: granted_capabilities,
        config,
        subscribedEvents: subscribed_events,
        priority,
      });

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'plugin_installed',
          target_type: 'repo',
          target_id: repoId,
          metadata: {
            repo_id: repoId,
            plugin_id: plugin_id,
            installation_id: installation.id,
            granted_capabilities,
          },
        });
      }

      // Dispatch plugin_installed event to other plugins
      if (pluginDispatcher) {
        await pluginDispatcher.dispatch(repoId, 'plugin_installed', {
          installation_id: installation.id,
          plugin_id: plugin_id,
          installed_by: agentId,
        });
      }

      return reply.status(201).send({ installation });
    } catch (error) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Update plugin installation config
  app.patch('/gitswarm/repos/:repoId/plugins/:installationId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const agentId = request.agent?.id;
    const { repoId, installationId } = request.params;

    // Verify maintainer
    const maintainer = await query(`
      SELECT role FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length === 0) {
      return reply.status(403).send({ error: 'Only maintainers can configure plugins' });
    }

    const { config, enabled, granted_capabilities, subscribed_events } = request.body;

    if (config) {
      await registryService.updateInstallationConfig(installationId, config);
    }

    if (enabled !== undefined) {
      await registryService.setInstallationEnabled(installationId, enabled);
    }

    if (granted_capabilities !== undefined) {
      await query(`
        UPDATE gitswarm_plugin_installations
        SET granted_capabilities = $2, updated_at = NOW()
        WHERE id = $1
      `, [installationId, JSON.stringify(granted_capabilities)]);
    }

    if (subscribed_events !== undefined) {
      await query(`
        UPDATE gitswarm_plugin_installations
        SET subscribed_events = $2, updated_at = NOW()
        WHERE id = $1
      `, [installationId, JSON.stringify(subscribed_events)]);
    }

    const result = await query(`
      SELECT pi.*, p.name as plugin_name, p.slug as plugin_slug
      FROM gitswarm_plugin_installations pi
      JOIN gitswarm_plugins p ON pi.plugin_id = p.id
      WHERE pi.id = $1
    `, [installationId]);

    return { installation: result.rows[0] };
  });

  // Uninstall a plugin from a repo
  app.delete('/gitswarm/repos/:repoId/plugins/:pluginId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const agentId = request.agent?.id;
    const { repoId, pluginId } = request.params;

    // Verify maintainer
    const maintainer = await query(`
      SELECT role FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length === 0) {
      return reply.status(403).send({ error: 'Only maintainers can uninstall plugins' });
    }

    const result = await registryService.uninstallPlugin(repoId, pluginId);

    if (!result) {
      return reply.status(404).send({ error: 'Plugin installation not found' });
    }

    if (activityService) {
      await activityService.logActivity({
        agent_id: agentId,
        event_type: 'plugin_uninstalled',
        target_type: 'repo',
        target_id: repoId,
        metadata: { repo_id: repoId, plugin_id: pluginId },
      });
    }

    return { uninstalled: true };
  });

  // ============================================================
  // Plugin Event History & Audit
  // ============================================================

  // Get plugin event history for a repo
  app.get('/gitswarm/repos/:repoId/plugin-events', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = request.params;
    const {
      plugin_id: pluginId,
      event_type: eventType,
      status,
      limit = 50,
      offset = 0,
    } = request.query;

    let sql = `
      SELECT pe.*, p.name as plugin_name, p.slug as plugin_slug
      FROM gitswarm_plugin_events pe
      JOIN gitswarm_plugins p ON pe.plugin_id = p.id
      WHERE pe.repo_id = $1
    `;
    const params = [repoId];
    let paramIdx = 1;

    if (pluginId) {
      paramIdx++;
      sql += ` AND pe.plugin_id = $${paramIdx}`;
      params.push(pluginId);
    }

    if (eventType) {
      paramIdx++;
      sql += ` AND pe.event_type = $${paramIdx}`;
      params.push(eventType);
    }

    if (status) {
      paramIdx++;
      sql += ` AND pe.status = $${paramIdx}`;
      params.push(status);
    }

    paramIdx++;
    sql += ` ORDER BY pe.created_at DESC LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit), 100));

    paramIdx++;
    sql += ` OFFSET $${paramIdx}`;
    params.push(parseInt(offset));

    const result = await query(sql, params);
    return { events: result.rows };
  });

  // Get plugin actions for a repo (audit trail)
  app.get('/gitswarm/repos/:repoId/plugin-actions', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request) => {
    const { repoId } = request.params;
    const {
      action_type: actionType,
      status,
      limit = 50,
      offset = 0,
    } = request.query;

    let sql = `
      SELECT pa.*, p.name as plugin_name, p.slug as plugin_slug
      FROM gitswarm_plugin_actions pa
      JOIN gitswarm_plugin_installations pi ON pa.installation_id = pi.id
      JOIN gitswarm_plugins p ON pi.plugin_id = p.id
      WHERE pa.repo_id = $1
    `;
    const params = [repoId];
    let paramIdx = 1;

    if (actionType) {
      paramIdx++;
      sql += ` AND pa.action_type = $${paramIdx}`;
      params.push(actionType);
    }

    if (status) {
      paramIdx++;
      sql += ` AND pa.status = $${paramIdx}`;
      params.push(status);
    }

    paramIdx++;
    sql += ` ORDER BY pa.created_at DESC LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit), 100));

    paramIdx++;
    sql += ` OFFSET $${paramIdx}`;
    params.push(parseInt(offset));

    const result = await query(sql, params);
    return { actions: result.rows };
  });

  // ============================================================
  // Plugin Capabilities Reference
  // ============================================================

  // List all available capabilities
  app.get('/gitswarm/plugin-capabilities', {
    preHandler: [authenticate, rateLimitRead],
  }, async () => {
    const result = await query(`
      SELECT * FROM gitswarm_plugin_capabilities
      ORDER BY category, risk_level, id
    `);
    return { capabilities: result.rows };
  });
}
