/**
 * gitswarm-cli — public API for programmatic use.
 *
 * Import this from other tools or multi-agent frameworks:
 *
 *   import { Federation } from 'gitswarm';
 *   const fed = Federation.open('/path/to/repo');
 *   const agents = await fed.listAgents();
 *   const { streamId, path } = await fed.createWorkspace({ agentId: agents[0].id });
 */
export { Federation } from './federation.js';
export { SqliteStore } from './store/sqlite.js';
export { PermissionService } from './core/permissions.js';
export { TaskService } from './core/tasks.js';
export { CouncilService } from './core/council.js';
export { StageService } from './core/stages.js';
export { ActivityService } from './core/activity.js';
export { SyncClient } from './sync-client.js';

// Re-export git-cascade for direct access when needed
export { MultiAgentRepoTracker } from 'git-cascade';
