/**
 * Federation Stage Service (CLI)
 *
 * Thin wrapper around the shared StageService,
 * pre-configured with SQLite adapter and CLI table names.
 *
 * Adds git-cascade tracker integration for metric updates.
 */
import { StageService as SharedStageService } from '../shared/stages.js';
import type { UpdateMetricsResult } from '../shared/stages.js';
import { createSqliteAdapter, createTableResolver, CLI_TABLES } from '../shared/query-adapter.js';
import type { SqliteStore } from '../store/sqlite.js';

const t = createTableResolver(CLI_TABLES);

// git-cascade tracker interface (loose type since package may not be available)
interface TrackerLike {
  listStreams(opts: { status: string }): Array<{ agentId: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export class StageService extends SharedStageService {
  constructor(store: SqliteStore) {
    const queryFn = createSqliteAdapter(store);
    super({ query: queryFn, t });
  }

  /**
   * Update repo metrics from git-cascade tracker or fallback to patches table.
   *
   * Overrides the shared version to support the tracker parameter
   * for direct git-cascade integration (avoids PG stream queries on CLI).
   */
  async updateMetrics(repoId: string, tracker: TrackerLike | null = null): Promise<UpdateMetricsResult> {
    if (tracker) {
      let contributorCount = 0;
      let streamCount = 0;
      try {
        const allStreams = tracker.listStreams({ status: 'merged' });
        streamCount = allStreams.length;
        const uniqueAgents = new Set(allStreams.map(s => s.agentId));
        contributorCount = uniqueAgents.size;
      } catch {
        // git-cascade tables may not exist yet
      }

      await this.query(
        `UPDATE ${t('repos')} SET contributor_count = $1, patch_count = $2, updated_at = $3 WHERE id = $4`,
        [contributorCount, streamCount, new Date().toISOString(), repoId]
      );
      return { contributor_count: contributorCount, patch_count: streamCount };
    }

    // Fallback to shared implementation (queries streams table)
    return super.updateRepoMetrics(repoId);
  }
}
