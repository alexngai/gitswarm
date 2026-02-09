/**
 * gitswarm-core shared services
 *
 * Database-agnostic core services shared between the CLI and web server.
 * Services accept a query function and table name resolver, making them
 * portable across PostgreSQL and SQLite.
 */
export { PermissionService } from './permissions.js';
export { StageService } from './stages.js';
export {
  createSqliteAdapter,
  createTableResolver,
  WEB_TABLES,
  CLI_TABLES,
} from './query-adapter.js';
