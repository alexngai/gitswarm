/**
 * Repository lifecycle stage progression.
 *
 * seed → growth → established → mature
 *
 * In v2, metrics are derived from git-cascade streams (merged stream count,
 * unique agent authors) rather than the deprecated patches table.
 */
export class StageService {
  constructor(store) {
    this.query = store.query.bind(store);
    this.thresholds = {
      growth:      { min_contributors: 2, min_patches: 3,  min_maintainers: 1 },
      established: { min_contributors: 5, min_patches: 10, min_maintainers: 2 },
      mature:      { min_contributors: 10, min_patches: 25, min_maintainers: 3, has_council: true },
    };
  }

  static STAGES = ['seed', 'growth', 'established', 'mature'];

  async getMetrics(repoId) {
    const r = await this.query(
      `SELECT r.id, r.stage, r.contributor_count, r.patch_count,
         (SELECT COUNT(*) FROM maintainers WHERE repo_id = r.id) as maintainer_count,
         (SELECT COUNT(*) FROM repo_councils WHERE repo_id = r.id AND status = 'active') as council_count
       FROM repos r WHERE r.id = ?`,
      [repoId]
    );
    if (r.rows.length === 0) throw new Error('Repository not found');
    const d = r.rows[0];
    return {
      repo_id: repoId,
      current_stage: d.stage,
      metrics: {
        contributor_count: d.contributor_count || 0,
        patch_count:       d.patch_count || 0,
        maintainer_count:  parseInt(d.maintainer_count) || 0,
        has_council:       parseInt(d.council_count) > 0,
      },
    };
  }

  async checkEligibility(repoId) {
    const { current_stage, metrics } = await this.getMetrics(repoId);
    const idx = StageService.STAGES.indexOf(current_stage);
    if (idx === StageService.STAGES.length - 1) {
      return { eligible: false, reason: 'already_at_max_stage', current_stage, next_stage: null };
    }
    const nextStage = StageService.STAGES[idx + 1];
    const reqs = this.thresholds[nextStage];
    const unmet = [];

    if (metrics.contributor_count < reqs.min_contributors)
      unmet.push({ requirement: 'min_contributors', required: reqs.min_contributors, current: metrics.contributor_count });
    if (metrics.patch_count < reqs.min_patches)
      unmet.push({ requirement: 'min_patches', required: reqs.min_patches, current: metrics.patch_count });
    if (metrics.maintainer_count < reqs.min_maintainers)
      unmet.push({ requirement: 'min_maintainers', required: reqs.min_maintainers, current: metrics.maintainer_count });
    if (reqs.has_council && !metrics.has_council)
      unmet.push({ requirement: 'has_council', required: true, current: false });

    return { eligible: unmet.length === 0, current_stage, next_stage: nextStage, requirements: reqs, metrics, unmet };
  }

  async advance(repoId, force = false) {
    const elig = await this.checkEligibility(repoId);
    if (!elig.eligible && !force) return { success: false, reason: 'requirements_not_met', eligibility: elig };
    if (!elig.next_stage) return { success: false, reason: 'already_at_max_stage' };

    await this.query(
      `INSERT INTO stage_history (repo_id, from_stage, to_stage, contributor_count, patch_count, maintainer_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [repoId, elig.current_stage, elig.next_stage, elig.metrics.contributor_count, elig.metrics.patch_count, elig.metrics.maintainer_count]
    );
    await this.query(
      `UPDATE repos SET stage = ?, updated_at = datetime('now') WHERE id = ?`,
      [elig.next_stage, repoId]
    );

    return { success: true, previous_stage: elig.current_stage, new_stage: elig.next_stage, metrics: elig.metrics };
  }

  /**
   * Update repo metrics from git-cascade streams.
   *
   * Counts merged streams (gc_streams where status = 'merged') and unique
   * agent authors. Falls back to counting from the patches table if
   * gc_streams doesn't exist yet (pre-v2 databases).
   */
  async updateMetrics(repoId, tracker = null) {
    let contributorCount = 0;
    let streamCount = 0;

    if (tracker) {
      // Use git-cascade streams for metrics
      try {
        const allStreams = tracker.listStreams({ status: 'merged' });
        streamCount = allStreams.length;
        const uniqueAgents = new Set(allStreams.map(s => s.agentId));
        contributorCount = uniqueAgents.size;
      } catch {
        // git-cascade tables may not exist yet
        contributorCount = 0;
        streamCount = 0;
      }
    } else {
      // Fallback: count from patches table (v1 compat)
      try {
        const contributors = await this.query(
          `SELECT COUNT(DISTINCT author_id) as c FROM patches WHERE repo_id = ? AND status = 'merged'`,
          [repoId]
        );
        const patches = await this.query(
          `SELECT COUNT(*) as c FROM patches WHERE repo_id = ? AND status = 'merged'`,
          [repoId]
        );
        contributorCount = parseInt(contributors.rows[0].c);
        streamCount = parseInt(patches.rows[0].c);
      } catch {
        contributorCount = 0;
        streamCount = 0;
      }
    }

    await this.query(
      `UPDATE repos SET contributor_count = ?, patch_count = ?, updated_at = datetime('now') WHERE id = ?`,
      [contributorCount, streamCount, repoId]
    );
    return { contributor_count: contributorCount, patch_count: streamCount };
  }

  async getHistory(repoId) {
    return (await this.query(
      `SELECT * FROM stage_history WHERE repo_id = ? ORDER BY transitioned_at DESC`, [repoId]
    )).rows;
  }
}
