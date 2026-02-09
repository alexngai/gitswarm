import { query } from '../config/database.js';
import { StageService as SharedStageService } from '../../shared/stages.js';
import { WEB_TABLES, createTableResolver } from '../../shared/query-adapter.js';

const t = createTableResolver(WEB_TABLES);

/**
 * GitSwarm Stage Progression Service (web server)
 *
 * Thin wrapper around the shared StageService,
 * pre-configured with PG query and web table names.
 */
export class StageProgressionService extends SharedStageService {
  constructor(db = null) {
    const queryFn = db?.query || query;
    super({ query: queryFn, t });
  }
}

// Export singleton instance
export const stageProgression = new StageProgressionService();
