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
export { generateId, isValidId, normalizeId } from './ids.js';
export { camelToSnake, normalizeKeys } from './field-normalize.js';

// Re-export all types from the shared type definitions
export type {
  QueryResult,
  QueryFn,
  TableResolver,
  TableMap,
  ServiceOptions,
  Agent,
  Repository,
  OwnershipModel,
  MergeMode,
  AgentAccess,
  Stage,
  Stream,
  StreamStatus,
  StreamReview,
  ReviewVerdict,
  Task,
  TaskStatus,
  TaskPriority,
  TaskClaim,
  Council,
  CouncilMember,
  Proposal,
  AccessLevel,
  PermissionAction,
  PermissionResult,
  ConsensusResult,
  BranchPushResult,
  StageThresholds,
  StageMetrics,
  StageAdvancementResult,
  ActivityEvent,
  ActivityRecord,
  FederationConfig,
  RateLimit,
  KarmaTier,
  WebSocketMessage,
  PluginDefinition,
} from './types.js';
