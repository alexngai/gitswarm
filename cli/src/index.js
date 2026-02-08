/**
 * gitswarm-cli — public API for programmatic use.
 *
 * Import this from other tools or multi-agent frameworks:
 *
 *   import { Federation } from 'gitswarm-cli';
 *   const fed = Federation.open('/path/to/repo');
 *   const agents = await fed.listAgents();
 */
export { Federation } from './federation.js';
export { SqliteStore } from './store/sqlite.js';
export { PermissionService } from './core/permissions.js';
export { TaskService } from './core/tasks.js';
export { CouncilService } from './core/council.js';
export { StageService } from './core/stages.js';
export { ActivityService } from './core/activity.js';
export { GitOps } from './core/git.js';
