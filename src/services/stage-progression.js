import { query } from '../config/database.js';

/**
 * Stage Progression Service
 * Handles repository lifecycle stage transitions (seed → growth → established → mature)
 */
export class StageProgressionService {
  constructor(db = null) {
    this.db = db;
    this.query = db?.query || query;

    // Stage progression thresholds
    this.thresholds = {
      growth: {
        min_contributors: 2,
        min_patches: 3,
        min_maintainers: 1
      },
      established: {
        min_contributors: 5,
        min_patches: 10,
        min_maintainers: 2
      },
      mature: {
        min_contributors: 10,
        min_patches: 25,
        min_maintainers: 3,
        has_council: true
      }
    };
  }

  /**
   * Get current stage metrics for a repository
   */
  async getStageMetrics(repoId) {
    // Get basic counts
    const repo = await this.query(`
      SELECT
        r.id, r.stage, r.contributor_count, r.patch_count,
        (SELECT COUNT(*) FROM gitswarm_maintainers WHERE repo_id = r.id) as maintainer_count,
        (SELECT COUNT(*) FROM gitswarm_repo_councils WHERE repo_id = r.id AND status = 'active') as council_count
      FROM gitswarm_repos r
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error('Repository not found');
    }

    const data = repo.rows[0];

    return {
      repo_id: repoId,
      current_stage: data.stage,
      metrics: {
        contributor_count: data.contributor_count || 0,
        patch_count: data.patch_count || 0,
        maintainer_count: parseInt(data.maintainer_count) || 0,
        has_council: parseInt(data.council_count) > 0
      }
    };
  }

  /**
   * Check if a repository is eligible for stage advancement
   */
  async checkAdvancementEligibility(repoId) {
    const { current_stage, metrics } = await this.getStageMetrics(repoId);

    const stageOrder = ['seed', 'growth', 'established', 'mature'];
    const currentIndex = stageOrder.indexOf(current_stage);

    if (currentIndex === stageOrder.length - 1) {
      return {
        eligible: false,
        reason: 'already_at_max_stage',
        current_stage,
        next_stage: null
      };
    }

    const nextStage = stageOrder[currentIndex + 1];
    const requirements = this.thresholds[nextStage];

    const unmetRequirements = [];

    if (metrics.contributor_count < requirements.min_contributors) {
      unmetRequirements.push({
        requirement: 'min_contributors',
        required: requirements.min_contributors,
        current: metrics.contributor_count
      });
    }

    if (metrics.patch_count < requirements.min_patches) {
      unmetRequirements.push({
        requirement: 'min_patches',
        required: requirements.min_patches,
        current: metrics.patch_count
      });
    }

    if (metrics.maintainer_count < requirements.min_maintainers) {
      unmetRequirements.push({
        requirement: 'min_maintainers',
        required: requirements.min_maintainers,
        current: metrics.maintainer_count
      });
    }

    if (requirements.has_council && !metrics.has_council) {
      unmetRequirements.push({
        requirement: 'has_council',
        required: true,
        current: false
      });
    }

    return {
      eligible: unmetRequirements.length === 0,
      current_stage,
      next_stage: nextStage,
      requirements,
      metrics,
      unmet_requirements: unmetRequirements
    };
  }

  /**
   * Advance repository to next stage
   */
  async advanceStage(repoId, force = false) {
    const eligibility = await this.checkAdvancementEligibility(repoId);

    if (!eligibility.eligible && !force) {
      return {
        success: false,
        reason: 'requirements_not_met',
        eligibility
      };
    }

    if (!eligibility.next_stage) {
      return {
        success: false,
        reason: 'already_at_max_stage'
      };
    }

    const { metrics, current_stage } = eligibility;

    // Record the transition
    await this.query(`
      INSERT INTO gitswarm_stage_history (
        repo_id, from_stage, to_stage,
        contributor_count, patch_count, maintainer_count
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      repoId,
      current_stage,
      eligibility.next_stage,
      metrics.contributor_count,
      metrics.patch_count,
      metrics.maintainer_count
    ]);

    // Update the repo stage
    await this.query(`
      UPDATE gitswarm_repos SET stage = $1, updated_at = NOW()
      WHERE id = $2
    `, [eligibility.next_stage, repoId]);

    return {
      success: true,
      previous_stage: current_stage,
      new_stage: eligibility.next_stage,
      metrics,
      forced: force && !eligibility.eligible
    };
  }

  /**
   * Manually set stage (for admins/owners)
   */
  async setStage(repoId, newStage, reason = null) {
    const validStages = ['seed', 'growth', 'established', 'mature'];
    if (!validStages.includes(newStage)) {
      throw new Error(`Invalid stage: ${newStage}`);
    }

    const { current_stage, metrics } = await this.getStageMetrics(repoId);

    if (current_stage === newStage) {
      return {
        success: false,
        reason: 'already_at_stage',
        current_stage
      };
    }

    // Record the transition
    await this.query(`
      INSERT INTO gitswarm_stage_history (
        repo_id, from_stage, to_stage,
        contributor_count, patch_count, maintainer_count
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      repoId,
      current_stage,
      newStage,
      metrics.contributor_count,
      metrics.patch_count,
      metrics.maintainer_count
    ]);

    // Update the repo stage
    await this.query(`
      UPDATE gitswarm_repos SET stage = $1, updated_at = NOW()
      WHERE id = $2
    `, [newStage, repoId]);

    return {
      success: true,
      previous_stage: current_stage,
      new_stage: newStage,
      reason
    };
  }

  /**
   * Get stage history for a repository
   */
  async getStageHistory(repoId) {
    const result = await this.query(`
      SELECT * FROM gitswarm_stage_history
      WHERE repo_id = $1
      ORDER BY transitioned_at DESC
    `, [repoId]);

    return result.rows;
  }

  /**
   * Check and auto-advance all eligible repositories
   * (Can be run as a scheduled job)
   */
  async checkAllReposForAdvancement() {
    const repos = await this.query(`
      SELECT id, stage FROM gitswarm_repos
      WHERE status = 'active' AND stage != 'mature'
    `);

    const results = {
      checked: repos.rows.length,
      advanced: 0,
      details: []
    };

    for (const repo of repos.rows) {
      const eligibility = await this.checkAdvancementEligibility(repo.id);

      if (eligibility.eligible) {
        const advancement = await this.advanceStage(repo.id);
        if (advancement.success) {
          results.advanced++;
          results.details.push({
            repo_id: repo.id,
            from: advancement.previous_stage,
            to: advancement.new_stage
          });
        }
      }
    }

    return results;
  }

  /**
   * Update repository metrics (contributor and merged stream counts)
   * Called after streams are merged or contributors are added
   */
  async updateRepoMetrics(repoId) {
    // Count unique contributors (agents with merged streams)
    const contributors = await this.query(`
      SELECT COUNT(DISTINCT s.agent_id) as count
      FROM gitswarm_streams s
      WHERE s.repo_id = $1 AND s.status = 'merged'
    `, [repoId]);

    // Count merged streams
    const streams = await this.query(`
      SELECT COUNT(*) as count
      FROM gitswarm_streams s
      WHERE s.repo_id = $1 AND s.status = 'merged'
    `, [repoId]);

    // Update repo
    await this.query(`
      UPDATE gitswarm_repos SET
        contributor_count = $1,
        patch_count = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [
      parseInt(contributors.rows[0].count),
      parseInt(streams.rows[0].count),
      repoId
    ]);

    return {
      contributor_count: parseInt(contributors.rows[0].count),
      patch_count: parseInt(streams.rows[0].count)
    };
  }

  /**
   * Get stage requirements
   */
  getStageRequirements(stage) {
    if (stage === 'seed') {
      return {
        description: 'Initial stage for new repositories',
        requirements: null
      };
    }
    return {
      requirements: this.thresholds[stage],
      description: this.getStageDescription(stage)
    };
  }

  /**
   * Get human-readable stage description
   */
  getStageDescription(stage) {
    const descriptions = {
      seed: 'New repository, minimal activity',
      growth: 'Growing repository with some contributors',
      established: 'Established repository with active community',
      mature: 'Mature repository with governance council'
    };
    return descriptions[stage] || 'Unknown stage';
  }
}

// Export singleton instance
export const stageProgression = new StageProgressionService();
