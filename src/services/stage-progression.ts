import { query } from '../config/database.js';
import { StageService as SharedStageService } from '../../shared/stages.js';
import { WEB_TABLES, createTableResolver } from '../../shared/query-adapter.js';

interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

const t: (table: string) => string = createTableResolver(WEB_TABLES);

/**
 * GitSwarm Stage Progression Service (web server)
 *
 * Thin wrapper around the shared StageService,
 * pre-configured with PG query and web table names.
 */
export class StageProgressionService extends SharedStageService {
  constructor(db: DbClient | null = null) {
    const queryFn = db?.query || query;
    super({ query: queryFn, t });
  }

  /**
   * Override shared updateRepoMetrics to use both streams AND merges tables.
   *
   * Streams synced from CLI may lag behind actual merges (due to sync timing).
   * gitswarm_merges is always written when a merge is recorded, so it's a more
   * reliable source for contributor and merge counts.
   */
  async updateRepoMetrics(repoId: string): Promise<{ contributor_count: number; patch_count: number }> {
    // Count from streams (primary source)
    const fromStreams = await (this as any).query(`
      SELECT COUNT(DISTINCT s.agent_id) as contributor_count,
             COUNT(*) as stream_count
      FROM ${t('streams')} s
      WHERE s.repo_id = $1 AND s.status = 'merged'
    `, [repoId]);

    // Count from merges (secondary — catches CLI syncs that wrote merges but not streams)
    const fromMerges = await (this as any).query(`
      SELECT COUNT(DISTINCT m.agent_id) as contributor_count,
             COUNT(*) as merge_count
      FROM gitswarm_merges m
      WHERE m.repo_id = $1
    `, [repoId]);

    // Use the higher value from either source
    const contributorCount = Math.max(
      parseInt(fromStreams.rows[0].contributor_count) || 0,
      parseInt(fromMerges.rows[0].contributor_count) || 0
    );
    const patchCount = Math.max(
      parseInt(fromStreams.rows[0].stream_count) || 0,
      parseInt(fromMerges.rows[0].merge_count) || 0
    );

    await (this as any).query(`
      UPDATE ${t('repos')} SET
        contributor_count = $1,
        patch_count = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [contributorCount, patchCount, repoId]);

    return { contributor_count: contributorCount, patch_count: patchCount };
  }
}

// Export singleton instance
export const stageProgression = new StageProgressionService();
