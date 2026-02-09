/**
 * Federation Permission Service (CLI)
 *
 * Thin wrapper around the shared PermissionService,
 * pre-configured with SQLite adapter and CLI table names.
 */
import { PermissionService as SharedPermissionService } from '../../../shared/permissions.js';
import { createSqliteAdapter, createTableResolver, CLI_TABLES } from '../../../shared/query-adapter.js';

const t = createTableResolver(CLI_TABLES);

export class PermissionService extends SharedPermissionService {
  constructor(store) {
    const queryFn = createSqliteAdapter(store);
    super({ query: queryFn, t });
  }
}
