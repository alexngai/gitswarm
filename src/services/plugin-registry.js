/**
 * Plugin Registry Service
 *
 * Manages the lifecycle of repo-level plugin agents:
 * - Plugin registration (creating new plugins in the registry)
 * - Plugin installation (installing a plugin on a repo)
 * - Configuration management (per-installation config)
 * - Capability validation (what a plugin is allowed to do)
 *
 * Plugins are distinct from contributor agents. They are automated
 * services that respond to GitSwarm events at the repo level,
 * bridging GitSwarm's internal coordination with external systems.
 */

import { query } from '../config/database.js';
import crypto from 'crypto';

class PluginRegistryService {
  constructor(db) {
    this.db = db || { query };
  }

  // ============================================================
  // Plugin Registration
  // ============================================================

  /**
   * Register a new plugin in the global registry.
   */
  async registerPlugin({
    name,
    slug,
    description,
    authorId,
    pluginType = 'webhook',
    webhookUrl,
    capabilities = [],
    subscribedEvents = [],
    configSchema = {},
    defaultConfig = {},
    homepageUrl,
    documentationUrl,
    githubActionRepo,
    githubActionWorkflow,
  }) {
    // Validate plugin type
    const validTypes = ['webhook', 'builtin', 'github_action'];
    if (!validTypes.includes(pluginType)) {
      throw new Error(`Invalid plugin type: ${pluginType}. Must be one of: ${validTypes.join(', ')}`);
    }

    // Webhook plugins require a URL
    if (pluginType === 'webhook' && !webhookUrl) {
      throw new Error('Webhook plugins must provide a webhook_url');
    }

    // GitHub Action plugins require repo + workflow
    if (pluginType === 'github_action' && (!githubActionRepo || !githubActionWorkflow)) {
      throw new Error('GitHub Action plugins must provide github_action_repo and github_action_workflow');
    }

    // Validate capabilities against known set
    await this._validateCapabilities(capabilities);

    // Validate subscribed events
    this._validateEvents(subscribedEvents);

    // Generate webhook secret for webhook plugins
    let webhookSecretHash = null;
    let webhookSecret = null;
    if (pluginType === 'webhook') {
      webhookSecret = crypto.randomBytes(32).toString('hex');
      webhookSecretHash = crypto
        .createHash('sha256')
        .update(webhookSecret)
        .digest('hex');
    }

    const result = await this.db.query(`
      INSERT INTO gitswarm_plugins (
        name, slug, description, author_id, plugin_type,
        webhook_url, webhook_secret_hash,
        github_action_repo, github_action_workflow,
        capabilities, subscribed_events,
        config_schema, default_config,
        homepage_url, documentation_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `, [
      name, slug, description, authorId, pluginType,
      webhookUrl, webhookSecretHash,
      githubActionRepo, githubActionWorkflow,
      JSON.stringify(capabilities), JSON.stringify(subscribedEvents),
      JSON.stringify(configSchema), JSON.stringify(defaultConfig),
      homepageUrl, documentationUrl,
    ]);

    const plugin = result.rows[0];

    // Return the secret only once at registration time
    return {
      ...plugin,
      webhook_secret: webhookSecret,
    };
  }

  /**
   * Get a plugin by ID or slug.
   */
  async getPlugin(idOrSlug) {
    const result = await this.db.query(`
      SELECT p.*, a.name as author_name
      FROM gitswarm_plugins p
      LEFT JOIN agents a ON p.author_id = a.id
      WHERE p.id::text = $1 OR p.slug = $1
    `, [idOrSlug]);

    return result.rows[0] || null;
  }

  /**
   * List plugins with optional filters.
   */
  async listPlugins({ status = 'active', pluginType, authorId, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT p.*, a.name as author_name
      FROM gitswarm_plugins p
      LEFT JOIN agents a ON p.author_id = a.id
      WHERE p.status = $1
    `;
    const params = [status];
    let paramIdx = 1;

    if (pluginType) {
      paramIdx++;
      sql += ` AND p.plugin_type = $${paramIdx}`;
      params.push(pluginType);
    }

    if (authorId) {
      paramIdx++;
      sql += ` AND p.author_id = $${paramIdx}`;
      params.push(authorId);
    }

    paramIdx++;
    sql += ` ORDER BY p.install_count DESC, p.created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    paramIdx++;
    sql += ` OFFSET $${paramIdx}`;
    params.push(offset);

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  // ============================================================
  // Plugin Installation
  // ============================================================

  /**
   * Install a plugin on a repository.
   *
   * The installer must be a maintainer/owner of the repo.
   * Capabilities are validated — critical capabilities require
   * the installer to be an owner.
   */
  async installPlugin({
    repoId,
    pluginId,
    installedBy,
    grantedCapabilities,
    config = {},
    subscribedEvents = null,
    priority = 100,
  }) {
    // Get the plugin
    const plugin = await this.getPlugin(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    if (plugin.status !== 'active') {
      throw new Error(`Plugin ${plugin.name} is not active (status: ${plugin.status})`);
    }

    // Validate granted capabilities are a subset of plugin's requested capabilities
    const requestedCaps = new Set(plugin.capabilities || []);
    for (const cap of grantedCapabilities) {
      if (!requestedCaps.has(cap)) {
        throw new Error(`Capability '${cap}' is not requested by plugin ${plugin.name}`);
      }
    }

    // Check if any granted capability requires maintainer status
    const criticalCaps = await this._getCriticalCapabilities(grantedCapabilities);
    if (criticalCaps.length > 0) {
      const isOwner = await this._isRepoOwner(repoId, installedBy);
      if (!isOwner) {
        throw new Error(
          `Granting capabilities [${criticalCaps.join(', ')}] requires repo owner role`
        );
      }
    }

    // Merge config with plugin defaults
    const mergedConfig = { ...plugin.default_config, ...config };

    const result = await this.db.query(`
      INSERT INTO gitswarm_plugin_installations (
        repo_id, plugin_id, installed_by,
        granted_capabilities, config, subscribed_events,
        priority
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (repo_id, plugin_id) DO UPDATE SET
        granted_capabilities = $4,
        config = $5,
        subscribed_events = $6,
        priority = $7,
        status = 'active',
        enabled = TRUE,
        updated_at = NOW()
      RETURNING *
    `, [
      repoId, plugin.id, installedBy,
      JSON.stringify(grantedCapabilities),
      JSON.stringify(mergedConfig),
      subscribedEvents ? JSON.stringify(subscribedEvents) : null,
      priority,
    ]);

    // Increment install count
    await this.db.query(`
      UPDATE gitswarm_plugins SET install_count = install_count + 1, updated_at = NOW()
      WHERE id = $1
    `, [plugin.id]);

    return result.rows[0];
  }

  /**
   * Uninstall a plugin from a repository.
   */
  async uninstallPlugin(repoId, pluginId) {
    const result = await this.db.query(`
      UPDATE gitswarm_plugin_installations
      SET status = 'uninstalled', enabled = FALSE, updated_at = NOW()
      WHERE repo_id = $1 AND plugin_id = $2
      RETURNING *
    `, [repoId, pluginId]);

    if (result.rows.length > 0) {
      await this.db.query(`
        UPDATE gitswarm_plugins SET install_count = GREATEST(0, install_count - 1), updated_at = NOW()
        WHERE id = $1
      `, [pluginId]);
    }

    return result.rows[0] || null;
  }

  /**
   * Update configuration for an installed plugin.
   */
  async updateInstallationConfig(installationId, config) {
    const result = await this.db.query(`
      UPDATE gitswarm_plugin_installations
      SET config = config || $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [installationId, JSON.stringify(config)]);

    return result.rows[0] || null;
  }

  /**
   * Enable or disable an installed plugin.
   */
  async setInstallationEnabled(installationId, enabled) {
    const result = await this.db.query(`
      UPDATE gitswarm_plugin_installations
      SET enabled = $2, status = CASE WHEN $2 THEN 'active' ELSE 'paused' END, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [installationId, enabled]);

    return result.rows[0] || null;
  }

  /**
   * List installations for a repo.
   */
  async listRepoInstallations(repoId, { includeDisabled = false } = {}) {
    let sql = `
      SELECT pi.*, p.name as plugin_name, p.slug as plugin_slug,
             p.plugin_type, p.description as plugin_description,
             p.is_official, p.is_verified,
             a.name as installed_by_name
      FROM gitswarm_plugin_installations pi
      JOIN gitswarm_plugins p ON pi.plugin_id = p.id
      LEFT JOIN agents a ON pi.installed_by = a.id
      WHERE pi.repo_id = $1
    `;
    const params = [repoId];

    if (!includeDisabled) {
      sql += ` AND pi.status = 'active' AND pi.enabled = TRUE`;
    } else {
      sql += ` AND pi.status != 'uninstalled'`;
    }

    sql += ` ORDER BY pi.priority ASC, pi.created_at ASC`;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  /**
   * Get installations subscribed to a specific event for a repo.
   * This is the hot path for event dispatch.
   */
  async getSubscribedInstallations(repoId, eventType) {
    const result = await this.db.query(`
      SELECT pi.*, p.name as plugin_name, p.slug as plugin_slug,
             p.plugin_type, p.webhook_url, p.webhook_secret_hash,
             p.github_action_repo, p.github_action_workflow
      FROM gitswarm_plugin_installations pi
      JOIN gitswarm_plugins p ON pi.plugin_id = p.id
      WHERE pi.repo_id = $1
        AND pi.enabled = TRUE
        AND pi.status = 'active'
        AND p.status = 'active'
        AND (
          -- Check installation-level override first, then plugin defaults
          (pi.subscribed_events IS NOT NULL AND pi.subscribed_events @> $2::jsonb)
          OR
          (pi.subscribed_events IS NULL AND p.subscribed_events @> $2::jsonb)
        )
      ORDER BY pi.priority ASC
    `, [repoId, JSON.stringify(eventType)]);

    return result.rows;
  }

  // ============================================================
  // Capability Validation
  // ============================================================

  /**
   * Check if an installation has a specific capability.
   */
  async hasCapability(installationId, capability) {
    const result = await this.db.query(`
      SELECT granted_capabilities FROM gitswarm_plugin_installations
      WHERE id = $1 AND enabled = TRUE AND status = 'active'
    `, [installationId]);

    if (result.rows.length === 0) return false;

    const caps = result.rows[0].granted_capabilities || [];
    return caps.includes(capability);
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  async _validateCapabilities(capabilities) {
    if (capabilities.length === 0) return;

    const result = await this.db.query(`
      SELECT id FROM gitswarm_plugin_capabilities WHERE id = ANY($1)
    `, [capabilities]);

    const known = new Set(result.rows.map(r => r.id));
    const unknown = capabilities.filter(c => !known.has(c));

    if (unknown.length > 0) {
      throw new Error(`Unknown capabilities: ${unknown.join(', ')}`);
    }
  }

  _validateEvents(events) {
    const validEvents = [
      // Stream lifecycle
      'stream_created', 'workspace_created', 'commit',
      'submit_for_review', 'review_submitted',
      'stream_merged', 'stream_abandoned',
      // Consensus
      'consensus_reached', 'consensus_blocked',
      // Stabilization & promotion
      'stabilization', 'stabilization_green', 'stabilization_red',
      'promote', 'promote_failed',
      // Issues & tasks
      'issue_opened', 'issue_closed', 'issue_labeled',
      'issue_comment', 'task_created', 'task_claimed',
      'task_submitted', 'task_completed',
      // Governance
      'council_proposal_created', 'council_proposal_passed',
      'council_proposal_failed', 'council_vote_cast',
      // Repository
      'repo_config_changed', 'maintainer_added', 'maintainer_removed',
      'agent_access_changed', 'stage_transition',
      // Plugin-specific
      'plugin_installed', 'plugin_uninstalled', 'plugin_action_executed',
    ];

    const validSet = new Set(validEvents);
    const invalid = events.filter(e => !validSet.has(e));
    if (invalid.length > 0) {
      throw new Error(`Unknown events: ${invalid.join(', ')}. Valid events: ${validEvents.join(', ')}`);
    }
  }

  async _getCriticalCapabilities(capabilities) {
    if (capabilities.length === 0) return [];

    const result = await this.db.query(`
      SELECT id FROM gitswarm_plugin_capabilities
      WHERE id = ANY($1) AND requires_maintainer = TRUE
    `, [capabilities]);

    return result.rows.map(r => r.id);
  }

  async _isRepoOwner(repoId, agentId) {
    const result = await this.db.query(`
      SELECT 1 FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2 AND role = 'owner'
    `, [repoId, agentId]);

    return result.rows.length > 0;
  }
}

export default PluginRegistryService;
