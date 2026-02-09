/**
 * Config Sync Service
 *
 * Reads .gitswarm/ directory from repos via GitHub API and syncs
 * the configuration to the database. Handles config.yml and plugins.yml.
 *
 * When a push event touches .gitswarm/ files, this service re-reads
 * the config and updates plugin registrations accordingly.
 */

import { githubApp } from './github.js';
import { GitHubRepo } from './github.js';
import yaml from 'js-yaml'; // Note: fallback to JSON parse if yaml not available

export class ConfigSyncService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Sync .gitswarm/ config for a repo. Called on:
   *  - push events that touch .gitswarm/ files
   *  - manual sync requests via API
   *  - app installation (initial sync)
   */
  async syncRepoConfig(repoId) {
    const repoResult = await this.db.query(`
      SELECT r.id, r.github_repo_id, r.github_full_name, r.default_branch,
             o.github_installation_id
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE r.id = $1 AND r.status = 'active'
    `, [repoId]);

    if (repoResult.rows.length === 0) {
      throw new Error(`Repo ${repoId} not found or inactive`);
    }

    const repo = repoResult.rows[0];
    if (!repo.github_installation_id) {
      throw new Error(`No GitHub installation for repo ${repoId}`);
    }

    const [owner, repoName] = repo.github_full_name.split('/');
    let token;
    try {
      token = await githubApp.getInstallationToken(repo.github_installation_id);
    } catch (err) {
      await this._recordSyncError(repoId, `Failed to get installation token: ${err.message}`);
      throw err;
    }

    const ghRepo = new GitHubRepo(token, owner, repoName);

    // Read config.yml and plugins.yml in parallel
    const [configResult, pluginsResult] = await Promise.allSettled([
      ghRepo.getFileContent('.gitswarm/config.yml', repo.default_branch),
      ghRepo.getFileContent('.gitswarm/plugins.yml', repo.default_branch),
    ]);

    const configData = configResult.status === 'fulfilled' && configResult.value
      ? this._parseYaml(configResult.value.content)
      : null;

    const pluginsData = pluginsResult.status === 'fulfilled' && pluginsResult.value
      ? this._parseYaml(pluginsResult.value.content)
      : null;

    if (!configData && !pluginsData) {
      // No .gitswarm/ config found — disable plugins for this repo
      await this.db.query(`
        UPDATE gitswarm_repos SET plugins_enabled = false, updated_at = NOW()
        WHERE id = $1
      `, [repoId]);

      await this.db.query(`
        INSERT INTO gitswarm_repo_config (repo_id, plugins_enabled, last_synced_at)
        VALUES ($1, false, NOW())
        ON CONFLICT (repo_id) DO UPDATE SET
          plugins_enabled = false, last_synced_at = NOW(), sync_error = NULL, updated_at = NOW()
      `, [repoId]);

      return { synced: false, reason: 'no_config_found' };
    }

    // Store parsed config
    const configSha = configResult.status === 'fulfilled' && configResult.value
      ? configResult.value.sha : null;
    const pluginsSha = pluginsResult.status === 'fulfilled' && pluginsResult.value
      ? pluginsResult.value.sha : null;

    const pluginsEnabled = configData?.plugins_enabled !== false;

    await this.db.query(`
      INSERT INTO gitswarm_repo_config (
        repo_id, config_sha, plugins_sha, config_data, plugins_data,
        plugins_enabled, last_synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (repo_id) DO UPDATE SET
        config_sha = $2, plugins_sha = $3, config_data = $4, plugins_data = $5,
        plugins_enabled = $6, last_synced_at = NOW(), sync_error = NULL, updated_at = NOW()
    `, [
      repoId, configSha, pluginsSha,
      JSON.stringify(configData || {}),
      JSON.stringify(pluginsData || {}),
      pluginsEnabled,
    ]);

    // Enable plugins on the repo
    await this.db.query(`
      UPDATE gitswarm_repos SET plugins_enabled = $2, updated_at = NOW()
      WHERE id = $1
    `, [repoId, pluginsEnabled]);

    // Sync repo-level settings from config.yml
    if (configData) {
      await this._syncRepoSettings(repoId, configData);
    }

    // Sync plugin registrations from plugins.yml
    if (pluginsData?.plugins) {
      await this._syncPlugins(repoId, pluginsData.plugins);
    }

    // Detect gh-aw workflows (.github/workflows/*.md)
    const ghawWorkflows = await this._detectGhAwWorkflows(ghRepo, repo.default_branch);

    return {
      synced: true,
      plugins_enabled: pluginsEnabled,
      plugins_count: pluginsData?.plugins ? Object.keys(pluginsData.plugins).length : 0,
      ghaw_workflows: ghawWorkflows.length,
    };
  }

  /**
   * Apply repo-level settings from .gitswarm/config.yml to gitswarm_repos.
   */
  async _syncRepoSettings(repoId, config) {
    const settingsMap = {
      merge_mode: config.merge_mode,
      ownership_model: config.ownership_model,
      consensus_threshold: config.consensus_threshold,
      min_reviews: config.min_reviews,
      human_review_weight: config.human_review_weight,
      agent_access: config.agent_access,
      min_karma: config.min_karma,
      buffer_branch: config.buffer_branch,
      promote_target: config.promote_target,
      auto_promote_on_green: config.auto_promote_on_green,
      auto_revert_on_red: config.auto_revert_on_red,
      stabilize_command: config.stabilize_command,
    };

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const [field, value] of Object.entries(settingsMap)) {
      if (value !== undefined) {
        updates.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      values.push(repoId);

      await this.db.query(`
        UPDATE gitswarm_repos SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
      `, values);
    }
  }

  /**
   * Sync plugin registrations from .gitswarm/plugins.yml into gitswarm_repo_plugins.
   * Reconciles: creates new, updates changed, disables removed.
   */
  async _syncPlugins(repoId, plugins) {
    const pluginNames = Object.keys(plugins);

    // Get current plugins from DB
    const existing = await this.db.query(`
      SELECT id, name FROM gitswarm_repo_plugins
      WHERE repo_id = $1 AND source = 'config'
    `, [repoId]);

    const existingNames = new Set(existing.rows.map(r => r.name));

    // Upsert each plugin from config
    for (const [name, pluginConfig] of Object.entries(plugins)) {
      const tier = this._inferTier(name, pluginConfig);
      const executionModel = this._inferExecutionModel(pluginConfig);

      await this.db.query(`
        INSERT INTO gitswarm_repo_plugins (
          repo_id, name, enabled, tier, trigger_event, conditions,
          actions, safe_outputs, config, execution_model, dispatch_target,
          priority, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'config')
        ON CONFLICT (repo_id, name) DO UPDATE SET
          enabled = $3, tier = $4, trigger_event = $5, conditions = $6,
          actions = $7, safe_outputs = $8, config = $9, execution_model = $10,
          dispatch_target = $11, priority = $12, updated_at = NOW()
      `, [
        repoId,
        name,
        pluginConfig.enabled !== false,
        tier,
        pluginConfig.trigger || 'manual',
        JSON.stringify(pluginConfig.conditions || {}),
        JSON.stringify(pluginConfig.actions || []),
        JSON.stringify(pluginConfig.safe_outputs || {}),
        JSON.stringify(this._extractPluginConfig(pluginConfig)),
        executionModel,
        pluginConfig.dispatch_target || `gitswarm.plugin.${name}`,
        pluginConfig.priority || 0,
      ]);
    }

    // Disable plugins that were removed from config
    for (const row of existing.rows) {
      if (!pluginNames.includes(row.name)) {
        await this.db.query(`
          UPDATE gitswarm_repo_plugins SET enabled = false, updated_at = NOW()
          WHERE id = $1
        `, [row.id]);
      }
    }
  }

  /**
   * Infer the plugin tier from its name and config.
   */
  _inferTier(name, config) {
    // Tier 3: governance delegation
    if (config.trigger?.startsWith('gitswarm.consensus') ||
        config.trigger?.startsWith('gitswarm.council') ||
        name.includes('consensus') || name.includes('governance') ||
        name.includes('karma-fast-track')) {
      return 'governance';
    }

    // Tier 2: AI-augmented
    if (config.engine || config.model ||
        name.includes('triage') || name.includes('summarize') ||
        name.includes('review') || name.includes('enrichment')) {
      return 'ai';
    }

    // Tier 1: deterministic automation
    return 'automation';
  }

  /**
   * Infer execution model from plugin config.
   */
  _inferExecutionModel(config) {
    if (config.execution_model) return config.execution_model;

    // AI plugins dispatch to GitHub Actions for compute
    if (config.engine || config.model) return 'dispatch';

    // Governance plugins with external conditions dispatch too
    if (config.trigger?.startsWith('gitswarm.consensus') ||
        config.trigger?.startsWith('gitswarm.council')) {
      return 'dispatch';
    }

    // Webhooks
    if (config.webhook_url) return 'webhook';

    // Simple automation can run built-in
    return 'builtin';
  }

  /**
   * Extract plugin-specific config fields (not trigger/actions/safe_outputs).
   */
  _extractPluginConfig(config) {
    const { trigger, conditions, actions, safe_outputs, enabled, priority,
            execution_model, dispatch_target, ...rest } = config;
    return rest;
  }

  /**
   * Parse YAML content with fallback to JSON.
   */
  _parseYaml(content) {
    try {
      // Try yaml parse first
      if (typeof yaml !== 'undefined' && yaml.load) {
        return yaml.load(content);
      }
    } catch (e) {
      // Fallback below
    }

    // Fallback: simple YAML-ish parser for the subset we need
    // This handles the basic key: value and nested structures
    try {
      return JSON.parse(content);
    } catch (e) {
      // Attempt basic YAML parsing
      return this._basicYamlParse(content);
    }
  }

  /**
   * Basic YAML parser for simple configs.
   * Handles the key: value structure we use in .gitswarm/ configs.
   */
  _basicYamlParse(content) {
    const result = {};
    const lines = content.split('\n');
    const stack = [{ obj: result, indent: -1 }];

    for (const line of lines) {
      // Skip comments and empty lines
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.length - trimmed.length;
      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!match) continue;

      const [, key, rawValue] = match;
      const cleanKey = key.trim();

      // Pop stack to find parent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].obj;

      if (rawValue.trim()) {
        // Simple value
        let value = rawValue.trim();
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Parse booleans and numbers
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (value === 'null') value = null;
        else if (!isNaN(value) && value !== '') value = Number(value);

        parent[cleanKey] = value;
      } else {
        // Nested object
        parent[cleanKey] = {};
        stack.push({ obj: parent[cleanKey], indent });
      }
    }

    return result;
  }

  /**
   * Detect gh-aw workflow files (.md in .github/workflows/) and register
   * them as plugins. gh-aw workflows are self-contained — they define their
   * own triggers, permissions, safe-outputs, and AI engine. We register
   * them in the plugin DB for visibility/tracking but they execute directly
   * via GitHub Actions (no dispatch from our server needed for native triggers).
   *
   * For gitswarm-only triggers (repository_dispatch types), our plugin engine
   * still dispatches the event.
   */
  async _detectGhAwWorkflows(ghRepo, branch) {
    const workflows = [];

    try {
      // List .github/workflows/ directory
      const listing = await ghRepo.request(
        'GET',
        `/repos/${ghRepo.owner}/${ghRepo.repo}/contents/.github/workflows?ref=${branch}`
      );

      if (!Array.isArray(listing)) return workflows;

      // Find .md files that are gh-aw workflows
      const mdFiles = listing.filter(f => f.name.endsWith('.md') && f.name.startsWith('gitswarm-'));

      for (const file of mdFiles) {
        try {
          const content = await ghRepo.getFileContent(`.github/workflows/${file.name}`, branch);
          if (!content) continue;

          const parsed = this._parseGhAwFrontmatter(content.content);
          if (!parsed) continue;

          workflows.push({
            filename: file.name,
            name: file.name.replace('.md', ''),
            ...parsed,
          });
        } catch (err) {
          // Skip files that can't be parsed
          console.log(`Skipping gh-aw file ${file.name}: ${err.message}`);
        }
      }
    } catch (err) {
      // Workflows directory doesn't exist or isn't accessible
      return workflows;
    }

    // Register detected gh-aw workflows as plugins (source = 'ghaw')
    for (const wf of workflows) {
      const triggerEvent = this._extractGhAwTrigger(wf.on);
      const tier = wf.engine ? 'ai' : 'automation';

      await this.db.query(`
        INSERT INTO gitswarm_repo_plugins (
          repo_id, name, enabled, tier, trigger_event, conditions,
          actions, safe_outputs, config, execution_model, dispatch_target,
          priority, source
        ) VALUES (
          (SELECT id FROM gitswarm_repos WHERE github_full_name = $1 LIMIT 1),
          $2, true, $3, $4, '{}', '[]', $5, $6, 'ghaw', $7, 0, 'ghaw'
        )
        ON CONFLICT (repo_id, name) DO UPDATE SET
          tier = $3, trigger_event = $4, safe_outputs = $5,
          config = $6, execution_model = 'ghaw', dispatch_target = $7,
          updated_at = NOW()
      `, [
        `${ghRepo.owner}/${ghRepo.repo}`,
        wf.name,
        tier,
        triggerEvent,
        JSON.stringify(wf.safe_outputs || {}),
        JSON.stringify({
          engine: wf.engine,
          description: wf.description,
          filename: wf.filename,
          tools: wf.tools,
          mcp_servers: wf.mcp_servers,
        }),
        wf.filename,
      ]);
    }

    return workflows;
  }

  /**
   * Parse gh-aw frontmatter from a Markdown workflow file.
   * Returns the frontmatter fields or null if not a valid gh-aw file.
   */
  _parseGhAwFrontmatter(content) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const frontmatter = this._parseYaml(fmMatch[1]);
    if (!frontmatter || !frontmatter.on) return null;

    return {
      on: frontmatter.on,
      description: frontmatter.description,
      engine: frontmatter.engine,
      tools: frontmatter.tools,
      permissions: frontmatter.permissions,
      safe_outputs: frontmatter['safe-outputs'],
      mcp_servers: frontmatter['mcp-servers'],
      timeout: frontmatter['timeout-minutes'],
      network: frontmatter.network,
    };
  }

  /**
   * Extract primary trigger event from gh-aw `on:` config.
   */
  _extractGhAwTrigger(on) {
    if (typeof on === 'string') return on;
    if (typeof on !== 'object') return 'unknown';

    // Check for repository_dispatch (gitswarm-specific triggers)
    if (on.repository_dispatch?.types?.[0]) {
      return on.repository_dispatch.types[0];
    }

    // Use the first native trigger
    const triggers = Object.keys(on);
    if (triggers.length === 0) return 'unknown';

    const first = triggers[0];
    const config = on[first];

    // Include action type if specified (e.g., issues.opened)
    if (config?.types?.[0]) {
      return `${first}.${config.types[0]}`;
    }

    return first;
  }

  async _recordSyncError(repoId, error) {
    await this.db.query(`
      INSERT INTO gitswarm_repo_config (repo_id, sync_error, last_synced_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (repo_id) DO UPDATE SET
        sync_error = $2, last_synced_at = NOW(), updated_at = NOW()
    `, [repoId, error]);
  }
}

export default ConfigSyncService;
