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
import yaml from 'js-yaml';

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

    // Detect gitswarm workflow templates (.github/workflows/gitswarm-*.yml)
    // and link them to existing config plugins instead of creating duplicates
    const detectedWorkflows = await this._detectWorkflowTemplates(ghRepo, repo.default_branch, repoId);

    return {
      synced: true,
      plugins_enabled: pluginsEnabled,
      plugins_count: pluginsData?.plugins ? Object.keys(pluginsData.plugins).length : 0,
      workflow_count: detectedWorkflows.length,
    };
  }

  /**
   * Apply repo-level settings from .gitswarm/config.yml to gitswarm_repos.
   *
   * Only syncs repo-owned fields. Server-owned fields (agent_access, min_karma,
   * ownership_model, is_private, stage, require_human_approval, human_can_force_merge)
   * are managed via the API and are NOT overwritten by config.yml.
   */
  async _syncRepoSettings(repoId, config) {
    // Repo-owned fields only — server-owned fields are excluded.
    const settingsMap = {
      merge_mode: config.merge_mode,
      consensus_threshold: config.consensus_threshold,
      min_reviews: config.min_reviews,
      human_review_weight: config.human_review_weight,
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
   * Parse YAML content. Requires js-yaml (listed in package.json dependencies).
   */
  _parseYaml(content) {
    return yaml.load(content);
  }

  /**
   * Detect gitswarm workflow files (.yml in .github/workflows/) and reconcile
   * them with existing config-sourced plugins.
   *
   * If a config plugin's dispatch_target matches a workflow's repository_dispatch
   * type, or their trigger events overlap, we LINK the config plugin to the
   * workflow file (set workflow_file, execution_model='workflow') rather than
   * creating a duplicate registration.
   *
   * Workflows without a matching config plugin are registered standalone.
   */
  async _detectWorkflowTemplates(ghRepo, branch, repoId) {
    const workflows = [];

    try {
      const listing = await ghRepo.request(
        'GET',
        `/repos/${ghRepo.owner}/${ghRepo.repo}/contents/.github/workflows?ref=${branch}`
      );

      if (!Array.isArray(listing)) return workflows;

      const ymlFiles = listing.filter(f =>
        (f.name.endsWith('.yml') || f.name.endsWith('.yaml')) &&
        f.name.startsWith('gitswarm-')
      );

      for (const file of ymlFiles) {
        try {
          const content = await ghRepo.getFileContent(`.github/workflows/${file.name}`, branch);
          if (!content) continue;

          const parsed = this._parseWorkflowYaml(content.content);
          if (!parsed) continue;

          workflows.push({
            filename: file.name,
            name: file.name.replace(/\.(yml|yaml)$/, ''),
            ...parsed,
          });
        } catch (err) {
          console.log(`Skipping workflow file ${file.name}: ${err.message}`);
        }
      }
    } catch (err) {
      return workflows;
    }

    if (!repoId) return workflows;

    // Get existing config-sourced plugins for this repo
    const existing = await this.db.query(`
      SELECT id, name, trigger_event, dispatch_target
      FROM gitswarm_repo_plugins
      WHERE repo_id = $1 AND source = 'config'
    `, [repoId]);

    const configPlugins = existing.rows;

    for (const wf of workflows) {
      const triggerEvent = this._extractWorkflowTrigger(wf.on);
      const allTriggers = this._extractAllWorkflowTriggers(wf.on);

      // Try to find a matching config plugin by:
      // 1. dispatch_target matches a repository_dispatch type in the workflow
      // 2. trigger_event matches one of the workflow's native triggers
      const matchingPlugin = configPlugins.find(cp => {
        // Check if config plugin's dispatch_target matches workflow's repo_dispatch types
        if (allTriggers.dispatchTypes.includes(cp.dispatch_target)) return true;
        // Check if trigger events overlap
        if (allTriggers.nativeTriggers.includes(cp.trigger_event)) return true;
        return false;
      });

      if (matchingPlugin) {
        // Link the config plugin to this workflow file instead of creating a duplicate.
        // Set execution_model to 'workflow' so the plugin engine knows the workflow
        // fires natively for GitHub triggers.
        await this.db.query(`
          UPDATE gitswarm_repo_plugins
          SET workflow_file = $2, execution_model = 'workflow', updated_at = NOW()
          WHERE id = $1
        `, [matchingPlugin.id, wf.filename]);
      } else {
        // No matching config plugin — register as a standalone workflow plugin
        const usesAiAction = wf.uses_ai_action;
        const tier = usesAiAction ? 'ai' : 'automation';

        await this.db.query(`
          INSERT INTO gitswarm_repo_plugins (
            repo_id, name, enabled, tier, trigger_event, conditions,
            actions, safe_outputs, config, execution_model, dispatch_target,
            priority, source, workflow_file
          ) VALUES ($1, $2, true, $3, $4, '{}', '[]', '{}', $5, 'workflow', $6, 0, 'workflow', $7)
          ON CONFLICT (repo_id, name) DO UPDATE SET
            tier = $3, trigger_event = $4,
            config = $5, execution_model = 'workflow', dispatch_target = $6,
            workflow_file = $7, updated_at = NOW()
        `, [
          repoId,
          wf.name,
          tier,
          triggerEvent,
          JSON.stringify({
            workflow_name: wf.workflow_name,
            description: wf.description,
            filename: wf.filename,
            permissions: wf.permissions,
            uses_ai_action: wf.uses_ai_action,
          }),
          wf.filename,
          wf.filename,
        ]);
      }
    }

    return workflows;
  }

  /**
   * Parse a GitHub Actions YAML workflow to extract metadata.
   * Returns relevant fields or null if not a valid workflow.
   */
  _parseWorkflowYaml(content) {
    const parsed = this._parseYaml(content);
    if (!parsed || !parsed.on) return null;

    // Detect if the workflow uses an AI agent action
    const contentStr = typeof content === 'string' ? content : '';
    const usesAiAction = contentStr.includes('anthropics/claude-code-action') ||
                         contentStr.includes('openai/codex-action') ||
                         contentStr.includes('github/copilot-');

    return {
      on: parsed.on,
      workflow_name: parsed.name,
      description: parsed.name || '',
      permissions: parsed.permissions,
      uses_ai_action: usesAiAction,
    };
  }

  /**
   * Extract primary trigger event from a workflow's `on:` config.
   */
  _extractWorkflowTrigger(on) {
    if (typeof on === 'string') return on;
    if (typeof on !== 'object') return 'unknown';

    // Prefer native triggers over repository_dispatch for the primary trigger,
    // since that's what the plugin engine matches against for audit.
    const nativeTriggers = Object.keys(on).filter(k =>
      k !== 'workflow_dispatch' && k !== 'repository_dispatch'
    );

    if (nativeTriggers.length > 0) {
      const first = nativeTriggers[0];
      const config = on[first];
      if (config?.types?.[0]) {
        return `${first}.${config.types[0]}`;
      }
      return first;
    }

    // Fall back to repository_dispatch
    if (on.repository_dispatch?.types?.[0]) {
      return on.repository_dispatch.types[0];
    }

    return 'unknown';
  }

  /**
   * Extract ALL trigger events from a workflow for matching against config plugins.
   * Returns { nativeTriggers: string[], dispatchTypes: string[] }
   */
  _extractAllWorkflowTriggers(on) {
    const result = { nativeTriggers: [], dispatchTypes: [] };
    if (typeof on === 'string') {
      result.nativeTriggers.push(on);
      return result;
    }
    if (typeof on !== 'object') return result;

    for (const [key, config] of Object.entries(on)) {
      if (key === 'repository_dispatch') {
        const types = config?.types || [];
        result.dispatchTypes.push(...types);
      } else if (key === 'workflow_dispatch' || key === 'schedule') {
        // Skip these for matching purposes
      } else {
        // Native trigger (issues, pull_request, issue_comment, etc.)
        if (config?.types) {
          for (const type of config.types) {
            result.nativeTriggers.push(`${key}.${type}`);
          }
        } else {
          result.nativeTriggers.push(key);
        }
      }
    }

    return result;
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
