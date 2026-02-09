/**
 * Query adapters for shared services.
 *
 * Shared services use PostgreSQL-style $1, $2 parameters.
 * The SQLite adapter converts these to ? placeholders.
 *
 * Table names are resolved through a table map so the same service
 * works with both `gitswarm_repos` (web/PG) and `repos` (CLI/SQLite).
 */

/**
 * Standard table mappings for each environment.
 */
export const WEB_TABLES = {
  agents: 'agents',
  repos: 'gitswarm_repos',
  orgs: 'gitswarm_orgs',
  repo_access: 'gitswarm_repo_access',
  maintainers: 'gitswarm_maintainers',
  branch_rules: 'gitswarm_branch_rules',
  stream_reviews: 'gitswarm_stream_reviews',
  streams: 'gitswarm_streams',
  stream_commits: 'gitswarm_stream_commits',
  stage_history: 'gitswarm_stage_history',
  repo_councils: 'gitswarm_repo_councils',
  merges: 'gitswarm_merges',
  stabilizations: 'gitswarm_stabilizations',
  promotions: 'gitswarm_promotions',
  tasks: 'gitswarm_tasks',
  task_claims: 'gitswarm_task_claims',
};

export const CLI_TABLES = {
  agents: 'agents',
  repos: 'repos',
  orgs: 'orgs',
  repo_access: 'repo_access',
  maintainers: 'maintainers',
  branch_rules: 'branch_rules',
  stream_reviews: 'patch_reviews',
  streams: 'gc_streams',
  stream_commits: 'gc_changes',
  stage_history: 'stage_history',
  repo_councils: 'repo_councils',
  merges: 'merges',
  stabilizations: 'stabilizations',
  promotions: 'promotions',
  tasks: 'tasks',
  task_claims: 'task_claims',
};

/**
 * Create a SQLite query adapter that converts $N params to ? placeholders.
 *
 * @param {object} store - Object with .query(sql, params) method
 * @returns {function} Async query function compatible with shared services
 */
export function createSqliteAdapter(store) {
  return async function query(sql, params = []) {
    const sqliteSQL = sql.replace(/\$\d+/g, '?');
    return store.query(sqliteSQL, params);
  };
}

/**
 * Create a table name resolver from a table map.
 *
 * @param {object} tableMap - Map of logical name to actual table name
 * @returns {function} t(logicalName) => actualTableName
 */
export function createTableResolver(tableMap) {
  return function t(name) {
    const resolved = tableMap[name];
    if (!resolved) throw new Error(`Unknown table: ${name}`);
    return resolved;
  };
}
