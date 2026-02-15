/**
 * Query adapters for shared services.
 *
 * Shared services use PostgreSQL-style $1, $2 parameters.
 * The SQLite adapter converts these to ? placeholders.
 *
 * Table names are resolved through a table map so the same service
 * works with both `gitswarm_repos` (web/PG) and `repos` (CLI/SQLite).
 */

export interface QueryResult {
  rows: Record<string, unknown>[];
  changes?: number;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): QueryResult | Promise<QueryResult>;
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;
export type TableResolver = (name: string) => string;

export interface TableMap {
  [logicalName: string]: string;
}

/**
 * Standard table mappings for each environment.
 */
export const WEB_TABLES: TableMap = {
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

export const CLI_TABLES: TableMap = {
  agents: 'agents',
  repos: 'repos',
  orgs: 'orgs',
  repo_access: 'repo_access',
  maintainers: 'maintainers',
  branch_rules: 'branch_rules',
  stream_reviews: 'patch_reviews',
  streams: 'streams',            // policy-level streams table (v4+)
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
 * PostgreSQL $N placeholders reference params by index ($1 = params[0]),
 * but they can appear in any order in the SQL. SQLite ? placeholders bind
 * sequentially, so we must reorder params to match appearance order.
 *
 * @param {object} store - Object with .query(sql, params) method
 * @returns {function} Async query function compatible with shared services
 */
export function createSqliteAdapter(store: Queryable): QueryFn {
  return async function query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    // Collect $N placeholders in order of appearance
    const indices: number[] = [];
    const sqliteSQL = sql.replace(/\$(\d+)/g, (_, n) => {
      indices.push(parseInt(n, 10) - 1); // $1 → index 0
      return '?';
    });
    // Reorder params to match appearance order
    const reordered = indices.length > 0
      ? indices.map(i => params[i])
      : params;
    return store.query(sqliteSQL, reordered);
  };
}

/**
 * Create a table name resolver from a table map.
 *
 * @param {object} tableMap - Map of logical name to actual table name
 * @returns {function} t(logicalName) => actualTableName
 */
export function createTableResolver(tableMap: TableMap): TableResolver {
  return function t(name: string): string {
    const resolved = tableMap[name];
    if (!resolved) throw new Error(`Unknown table: ${name}`);
    return resolved;
  };
}
