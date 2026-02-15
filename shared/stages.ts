/**
 * Shared Stage Progression Service
 *
 * Repository lifecycle: seed -> growth -> established -> mature
 *
 * Uses PostgreSQL-style $N parameters. CLI consumers should wrap
 * with createSqliteAdapter() from query-adapter.js.
 */
import type {
  QueryFn,
  TableResolver,
  ServiceOptions,
  Stage,
  StageThresholds,
  StageMetrics,
  StageAdvancementResult,
} from './types.js';

/** Metrics query result for a single repository. */
interface StageMetricsResult {
  repo_id: string;
  current_stage: Stage;
  metrics: StageMetrics;
}

/** Result from advanceStage(). */
interface AdvanceResult {
  success: boolean;
  reason?: string;
  previous_stage?: Stage;
  new_stage?: Stage;
  metrics?: StageMetrics;
  forced?: boolean;
  eligibility?: StageAdvancementResult;
  current_stage?: Stage;
}

/** Result from setStage(). */
interface SetStageResult {
  success: boolean;
  reason?: string;
  previous_stage?: Stage;
  new_stage?: Stage;
  current_stage?: Stage;
}

/** Result from updateRepoMetrics(). */
interface MetricsUpdateResult {
  contributor_count: number;
  patch_count: number;
}

/** Detail entry for a single repo advancement in bulk check. */
interface AdvancementDetail {
  repo_id: string;
  from: Stage;
  to: Stage;
}

/** Result from checkAllReposForAdvancement(). */
interface BulkAdvancementResult {
  checked: number;
  advanced: number;
  details: AdvancementDetail[];
}

/** Description of stage requirements. */
interface StageRequirementsInfo {
  description: string;
  requirements: StageThresholds | null;
}

/** Row from a stage_history query. */
type StageHistoryRow = Record<string, unknown>;

export class StageService {
  private query: QueryFn;
  private t: TableResolver;
  private thresholds: Record<string, StageThresholds>;

  static STAGES: Stage[] = ['seed', 'growth', 'established', 'mature'];

  constructor({ query, t = (name: string): string => name }: ServiceOptions) {
    this.query = query;
    this.t = t;
    this.thresholds = {
      growth:      { min_contributors: 2,  min_patches: 3,  min_maintainers: 1 },
      established: { min_contributors: 5,  min_patches: 10, min_maintainers: 2 },
      mature:      { min_contributors: 10, min_patches: 25, min_maintainers: 3, has_council: true },
    };
  }

  /**
   * Get current stage metrics for a repository.
   */
  async getStageMetrics(repoId: string): Promise<StageMetricsResult> {
    const t = this.t;
    const r = await this.query(`
      SELECT r.id, r.stage, r.contributor_count, r.patch_count,
        (SELECT COUNT(*) FROM ${t('maintainers')} WHERE repo_id = r.id) as maintainer_count,
        (SELECT COUNT(*) FROM ${t('repo_councils')} WHERE repo_id = r.id AND status = 'active') as council_count
      FROM ${t('repos')} r
      WHERE r.id = $1
    `, [repoId]);

    if (r.rows.length === 0) throw new Error('Repository not found');

    const d = r.rows[0] as {
      id: string;
      stage: Stage;
      contributor_count: number | null;
      patch_count: number | null;
      maintainer_count: number | string;
      council_count: number | string;
    };
    return {
      repo_id: repoId,
      current_stage: d.stage,
      metrics: {
        // BUG-16 fix: Safe coercion for potentially null/undefined DB values
        contributor_count: Number(d.contributor_count ?? 0),
        patch_count:       Number(d.patch_count ?? 0),
        maintainer_count:  Number(d.maintainer_count ?? 0),
        has_council:       Number(d.council_count ?? 0) > 0,
      },
    };
  }

  /**
   * Check if a repository is eligible for stage advancement.
   */
  async checkAdvancementEligibility(repoId: string): Promise<StageAdvancementResult> {
    const { current_stage, metrics } = await this.getStageMetrics(repoId);
    const idx = StageService.STAGES.indexOf(current_stage);

    if (idx === StageService.STAGES.length - 1) {
      return { eligible: false, reason: 'already_at_max_stage', current_stage, next_stage: null };
    }

    const nextStage: Stage = StageService.STAGES[idx + 1];
    const reqs: StageThresholds = this.thresholds[nextStage];
    const unmet: Array<{ requirement: string; required: number | boolean; current: number | boolean }> = [];

    if (metrics.contributor_count < reqs.min_contributors)
      unmet.push({ requirement: 'min_contributors', required: reqs.min_contributors, current: metrics.contributor_count });
    if (metrics.patch_count < reqs.min_patches)
      unmet.push({ requirement: 'min_patches', required: reqs.min_patches, current: metrics.patch_count });
    if (metrics.maintainer_count < reqs.min_maintainers)
      unmet.push({ requirement: 'min_maintainers', required: reqs.min_maintainers, current: metrics.maintainer_count });
    if (reqs.has_council && !metrics.has_council)
      unmet.push({ requirement: 'has_council', required: true, current: false });

    return {
      eligible: unmet.length === 0,
      current_stage,
      next_stage: nextStage,
      requirements: reqs,
      metrics,
      unmet_requirements: unmet,
    };
  }

  /**
   * Advance repository to next stage.
   */
  async advanceStage(repoId: string, force: boolean = false): Promise<AdvanceResult> {
    const t = this.t;
    const elig = await this.checkAdvancementEligibility(repoId);

    if (!elig.eligible && !force) {
      return { success: false, reason: 'requirements_not_met', eligibility: elig };
    }
    if (!elig.next_stage) {
      return { success: false, reason: 'already_at_max_stage' };
    }

    await this.query(`
      INSERT INTO ${t('stage_history')} (repo_id, from_stage, to_stage, contributor_count, patch_count, maintainer_count)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [repoId, elig.current_stage, elig.next_stage,
        elig.metrics!.contributor_count, elig.metrics!.patch_count, elig.metrics!.maintainer_count]);

    await this.query(`
      UPDATE ${t('repos')} SET stage = $1, updated_at = NOW() WHERE id = $2
    `, [elig.next_stage, repoId]);

    return {
      success: true,
      previous_stage: elig.current_stage,
      new_stage: elig.next_stage,
      metrics: elig.metrics,
      forced: force && !elig.eligible,
    };
  }

  /**
   * Manually set stage (for admins/owners).
   */
  async setStage(repoId: string, newStage: Stage, reason: string | null = null): Promise<SetStageResult> {
    const t = this.t;
    if (!StageService.STAGES.includes(newStage)) {
      throw new Error(`Invalid stage: ${newStage}`);
    }

    const { current_stage, metrics } = await this.getStageMetrics(repoId);
    if (current_stage === newStage) {
      return { success: false, reason: 'already_at_stage', current_stage };
    }

    await this.query(`
      INSERT INTO ${t('stage_history')} (repo_id, from_stage, to_stage, contributor_count, patch_count, maintainer_count)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [repoId, current_stage, newStage,
        metrics.contributor_count, metrics.patch_count, metrics.maintainer_count]);

    await this.query(`
      UPDATE ${t('repos')} SET stage = $1, updated_at = NOW() WHERE id = $2
    `, [newStage, repoId]);

    return { success: true, previous_stage: current_stage, new_stage: newStage, reason };
  }

  /**
   * Update repository metrics from merged streams.
   */
  async updateRepoMetrics(repoId: string): Promise<MetricsUpdateResult> {
    const t = this.t;

    const contributors = await this.query(`
      SELECT COUNT(DISTINCT s.agent_id) as count
      FROM ${t('streams')} s
      WHERE s.repo_id = $1 AND s.status = 'merged'
    `, [repoId]);

    const streams = await this.query(`
      SELECT COUNT(*) as count
      FROM ${t('streams')} s
      WHERE s.repo_id = $1 AND s.status = 'merged'
    `, [repoId]);

    await this.query(`
      UPDATE ${t('repos')} SET
        contributor_count = $1,
        patch_count = $2,
        updated_at = NOW()
      WHERE id = $3
    // BUG-16 fix: Safe access with optional chaining
    `, [Number((contributors.rows[0] as { count?: number } | undefined)?.count ?? 0), Number((streams.rows[0] as { count?: number } | undefined)?.count ?? 0), repoId]);

    return {
      contributor_count: Number((contributors.rows[0] as { count?: number } | undefined)?.count ?? 0),
      patch_count: Number((streams.rows[0] as { count?: number } | undefined)?.count ?? 0),
    };
  }

  /**
   * Get stage transition history.
   */
  async getStageHistory(repoId: string): Promise<StageHistoryRow[]> {
    const r = await this.query(`
      SELECT * FROM ${this.t('stage_history')}
      WHERE repo_id = $1
      ORDER BY transitioned_at DESC
    `, [repoId]);
    return r.rows as StageHistoryRow[];
  }

  /**
   * Check and auto-advance all eligible repositories.
   */
  async checkAllReposForAdvancement(): Promise<BulkAdvancementResult> {
    const t = this.t;
    const repos = await this.query(`
      SELECT id, stage FROM ${t('repos')}
      WHERE status = 'active' AND stage != 'mature'
    `);

    const results: BulkAdvancementResult = { checked: repos.rows.length, advanced: 0, details: [] };

    for (const repo of repos.rows) {
      const { id } = repo as { id: string; stage: Stage };
      const elig = await this.checkAdvancementEligibility(id);
      if (elig.eligible) {
        const adv = await this.advanceStage(id);
        if (adv.success) {
          results.advanced++;
          results.details.push({ repo_id: id, from: adv.previous_stage!, to: adv.new_stage! });
        }
      }
    }

    return results;
  }

  /**
   * Get human-readable stage requirements.
   */
  getStageRequirements(stage: Stage): StageRequirementsInfo {
    if (stage === 'seed') {
      return { description: 'Initial stage for new repositories', requirements: null };
    }
    return {
      requirements: this.thresholds[stage],
      description: this.getStageDescription(stage),
    };
  }

  getStageDescription(stage: Stage): string {
    const descriptions: Record<Stage, string> = {
      seed: 'New repository, minimal activity',
      growth: 'Growing repository with some contributors',
      established: 'Established repository with active community',
      mature: 'Mature repository with governance council',
    };
    return descriptions[stage] || 'Unknown stage';
  }
}
