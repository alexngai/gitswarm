/**
 * Repo-Level Config Reader
 *
 * Reads .gitswarm/config.yml and .gitswarm/plugins.yml from the local
 * repository checkout. This bridges the gap between the repo-level YAML
 * config (which the server syncs via GitHub API) and the CLI's local
 * config.json.
 *
 * Priority: config.yml > config.json for repo-owned fields.
 * Server-owned fields in config.yml are ignored (same as server behavior).
 */
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import yaml from 'js-yaml';

const GITSWARM_DIR = '.gitswarm';

// Fields that can be set via config.yml (repo-owned).
// Mirrors the server's ConfigSyncService field mapping.
const REPO_OWNED_FIELDS: string[] = [
  'merge_mode', 'consensus_threshold', 'min_reviews',
  'human_review_weight', 'buffer_branch', 'promote_target',
  'auto_promote_on_green', 'auto_revert_on_red', 'stabilize_command',
  'plugins_enabled',
];

export interface GitSwarmConfig {
  merge_mode?: string;
  consensus_threshold?: number;
  min_reviews?: number;
  human_review_weight?: number;
  buffer_branch?: string;
  promote_target?: string;
  auto_promote_on_green?: boolean | string | number;
  auto_revert_on_red?: boolean | string | number;
  stabilize_command?: string;
  plugins_enabled?: boolean | string | number;
  [key: string]: unknown;
}

export interface PluginDefinition {
  enabled?: boolean;
  trigger?: string;
  conditions?: Record<string, unknown> | null;
  actions?: unknown[];
  safe_outputs?: Record<string, unknown>;
  engine?: string;
  model?: string;
  context?: unknown;
  risk_rules?: unknown;
  [key: string]: unknown;
}

export interface PluginsConfig {
  plugins?: Record<string, PluginDefinition>;
  [key: string]: unknown;
}

export interface ParsedPlugin {
  name: string;
  enabled: boolean;
  tier: string;
  trigger_event: string | null;
  conditions: Record<string, unknown> | null;
  actions: unknown[];
  safe_outputs: Record<string, unknown>;
  config: {
    engine: string | undefined;
    model: string | undefined;
    context: unknown;
    risk_rules: unknown;
  };
  source: string;
}

/**
 * Read and parse .gitswarm/config.yml from the repo.
 * Returns null if file doesn't exist.
 */
export function readConfigYml(repoPath: string): GitSwarmConfig | null {
  const configPath = join(repoPath, GITSWARM_DIR, 'config.yml');
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    return (yaml.load(content) as GitSwarmConfig) || {};
  } catch (err) {
    console.error(`Warning: failed to parse .gitswarm/config.yml: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read and parse .gitswarm/plugins.yml from the repo.
 * Returns null if file doesn't exist.
 */
export function readPluginsYml(repoPath: string): PluginsConfig | null {
  const pluginsPath = join(repoPath, GITSWARM_DIR, 'plugins.yml');
  if (!existsSync(pluginsPath)) return null;

  try {
    const content = readFileSync(pluginsPath, 'utf-8');
    return (yaml.load(content) as PluginsConfig) || {};
  } catch (err) {
    console.error(`Warning: failed to parse .gitswarm/plugins.yml: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Extract repo-owned fields from parsed config.yml.
 * Returns only the fields that should update the repos table.
 * Converts boolean-like strings and normalizes types.
 */
export function extractRepoFields(config: GitSwarmConfig | null): Record<string, unknown> {
  if (!config) return {};

  const fields: Record<string, unknown> = {};
  for (const key of REPO_OWNED_FIELDS) {
    if (config[key] !== undefined) {
      let value: unknown = config[key];

      // Normalize booleans to integers for SQLite
      if (key === 'auto_promote_on_green' || key === 'auto_revert_on_red' || key === 'plugins_enabled') {
        value = value === true || value === 'true' || value === 1 ? 1 : 0;
      }

      // Normalize numeric fields
      if (key === 'consensus_threshold' || key === 'human_review_weight') {
        value = Number(value);
        if (isNaN(value as number)) continue;
      }
      if (key === 'min_reviews') {
        value = parseInt(value as string, 10);
        if (isNaN(value as number)) continue;
      }

      fields[key] = value;
    }
  }

  return fields;
}

/**
 * Parse plugin definitions from plugins.yml into a normalized structure.
 * Returns an array of plugin objects matching the server's format.
 */
export function parsePlugins(pluginsConfig: PluginsConfig | null): ParsedPlugin[] {
  if (!pluginsConfig?.plugins) return [];

  const plugins: ParsedPlugin[] = [];
  for (const [name, def] of Object.entries(pluginsConfig.plugins)) {
    if (!def || typeof def !== 'object') continue;

    // Infer tier from plugin content
    const tier = inferTier(name, def);

    plugins.push({
      name,
      enabled: def.enabled !== false,
      tier,
      trigger_event: def.trigger || null,
      conditions: def.conditions || null,
      actions: Array.isArray(def.actions) ? def.actions : [],
      safe_outputs: def.safe_outputs || {},
      config: {
        engine: def.engine,
        model: def.model,
        context: def.context,
        risk_rules: def.risk_rules,
      },
      source: 'config',
    });
  }

  return plugins;
}

/**
 * Infer plugin tier from its definition (mirrors server logic).
 */
function inferTier(name: string, def: PluginDefinition): string {
  const trigger = def.trigger || '';
  const hasAiIndicators = def.engine || def.model ||
    trigger.includes('triage') || trigger.includes('review') ||
    name.includes('enrichment') || name.includes('risk');

  const hasGovernanceIndicators =
    trigger.includes('gitswarm.consensus') ||
    trigger.includes('gitswarm.council') ||
    name.includes('consensus') ||
    name.includes('karma-fast-track');

  if (hasGovernanceIndicators) return 'governance';
  if (hasAiIndicators) return 'ai';
  return 'automation';
}
