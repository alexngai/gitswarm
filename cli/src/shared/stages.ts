/**
 * Shared Stage Progression Service
 *
 * Repository lifecycle: seed -> growth -> established -> mature
 *
 * Uses PostgreSQL-style $N parameters. CLI consumers should wrap
 * with createSqliteAdapter() from query-adapter.js.
 */
import type { QueryFn, TableResolver } from './query-adapter.js';

export interface StageMetrics {
  contributor_count: number;
  patch_count: number;
  maintainer_count: number;
  has_council: boolean;
}

export interface StageMetricsResult {
  repo_id: string;
  current_stage: string;
  metrics: StageMetrics;
}

export interface StageThreshold {
  min_contributors: number;
  min_patches: number;
  min_maintainers: number;
  has_council?: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  current_stage: string;
  next_stage: string | null;
  requirements?: StageThreshold;
  metrics?: StageMetrics;
  unmet_requirements?: Array<{ requirement: string; required: number | boolean; current: number | boolean }>;
}

export interface AdvanceResult {
  success: boolean;
  reason?: string;
  previous_stage?: string;
  new_stage?: string;
  metrics?: StageMetrics;
  forced?: boolean;
  eligibility?: EligibilityResult;
  current_stage?: string;
}

export interface UpdateMetricsResult {
  contributor_count: number;
  patch_count: number;
}

export class StageService {
  protected query: QueryFn;
  protected t: TableResolver;
  protected thresholds: Record<string, StageThreshold>;

  static STAGES: string[] = ['seed', 'growth', 'established', 'mature'];

  /**
   * @param {object} opts
   * @param {function} opts.query - async (sql, params) => { rows: [...] }
   * @param {function} opts.t     - (logicalName) => actualTableName
   */
  constructor({ query, t = (name: string): string => name }: { query: QueryFn; t?: TableResolver }) {
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

    const d = r.rows[0] as Record<string, unknown>;
    return {
      repo_id: repoId,
      current_stage: d.stage as string,
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
  async checkAdvancementEligibility(repoId: string): Promise<EligibilityResult> {
    const { current_stage, metrics } = await this.getStageMetrics(repoId);
    const idx = StageService.STAGES.indexOf(current_stage);

    if (idx === StageService.STAGES.length - 1) {
      return { eligible: false, reason: 'already_at_max_stage', current_stage, next_stage: null };
    }

    const nextStage = StageService.STAGES[idx + 1];
    const reqs = this.thresholds[nextStage];
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
  async setStage(repoId: string, newStage: string, reason: string | null = null): Promise<AdvanceResult> {
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

    return { success: true, previous_stage: current_stage, new_stage: newStage, reason: reason ?? undefined };
  }

  /**
   * Update repository metrics from merged streams.
   */
  async updateRepoMetrics(repoId: string): Promise<UpdateMetricsResult> {
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
    `, [Number(contributors.rows[0]?.count ?? 0), Number(streams.rows[0]?.count ?? 0), repoId]);

    return {
      contributor_count: Number(contributors.rows[0]?.count ?? 0),
      patch_count: Number(streams.rows[0]?.count ?? 0),
    };
  }

  /**
   * Get stage transition history.
   */
  async getStageHistory(repoId: string): Promise<Record<string, unknown>[]> {
    const r = await this.query(`
      SELECT * FROM ${this.t('stage_history')}
      WHERE repo_id = $1
      ORDER BY transitioned_at DESC
    `, [repoId]);
    return r.rows;
  }

  /**
   * Check and auto-advance all eligible repositories.
   */
  async checkAllReposForAdvancement(): Promise<{ checked: number; advanced: number; details: Array<{ repo_id: string; from: string; to: string }> }> {
    const t = this.t;
    const repos = await this.query(`
      SELECT id, stage FROM ${t('repos')}
      WHERE status = 'active' AND stage != 'mature'
    `);

    const results: { checked: number; advanced: number; details: Array<{ repo_id: string; from: string; to: string }> } = { checked: repos.rows.length, advanced: 0, details: [] };

    for (const repo of repos.rows) {
      const elig = await this.checkAdvancementEligibility(repo.id as string);
      if (elig.eligible) {
        const adv = await this.advanceStage(repo.id as string);
        if (adv.success) {
          results.advanced++;
          results.details.push({ repo_id: repo.id as string, from: adv.previous_stage!, to: adv.new_stage! });
        }
      }
    }

    return results;
  }

  /**
   * Get human-readable stage requirements.
   */
  getStageRequirements(stage: string): { description: string; requirements: StageThreshold | null } {
    if (stage === 'seed') {
      return { description: 'Initial stage for new repositories', requirements: null };
    }
    return {
      requirements: this.thresholds[stage],
      description: this.getStageDescription(stage),
    };
  }

  getStageDescription(stage: string): string {
    const descriptions: Record<string, string> = {
      seed: 'New repository, minimal activity',
      growth: 'Growing repository with some contributors',
      established: 'Established repository with active community',
      mature: 'Mature repository with governance council',
    };
    return descriptions[stage] || 'Unknown stage';
  }
}
