/**
 * Repo State Aggregation Service
 *
 * Computes per-repo summaries used by:
 * - OpenHive sync service (push state to coordination contexts)
 * - REST status endpoint (agents/dashboards query repo health)
 * - Internal decision-making (should we accept new work?)
 */
import { query } from '../config/database.js';

export interface RepoState {
  repo_id: string;
  repo_name: string;
  open_streams: number;
  streams_in_review: number;
  consensus_pending: string[];
  active_agents: string[];
  buffer_status: 'green' | 'red' | 'unknown';
  buffer_ahead_of_main: number;
  last_merge: { stream_name: string; at: string } | null;
  last_stabilization: { result: string; at: string } | null;
  last_promotion: { from: string; to: string; at: string } | null;
  computed_at: string;
}

/**
 * Get the current state summary of a repository.
 */
export async function getRepoState(repoId: string): Promise<RepoState> {
  // Repo info
  const repoResult = await query(
    'SELECT id, name, buffer_branch, promote_target FROM gitswarm_repos WHERE id = $1',
    [repoId]
  );
  const repo = repoResult.rows[0];
  if (!repo) throw new Error(`Repo not found: ${repoId}`);

  // Stream counts
  const streamCounts = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('active', 'in_review')) as open_streams,
      COUNT(*) FILTER (WHERE status = 'in_review') as streams_in_review
    FROM gitswarm_streams WHERE repo_id = $1
  `, [repoId]);

  // Streams with reviews but consensus not yet reached
  // (streams in_review that have at least one review)
  const pendingConsensus = await query(`
    SELECT s.id, s.name FROM gitswarm_streams s
    WHERE s.repo_id = $1 AND s.status = 'in_review'
      AND EXISTS (SELECT 1 FROM gitswarm_stream_reviews r WHERE r.stream_id = s.id)
  `, [repoId]);

  // Active agents (agents with open streams)
  const activeAgents = await query(`
    SELECT DISTINCT a.name
    FROM gitswarm_streams s
    JOIN agents a ON s.agent_id = a.id
    WHERE s.repo_id = $1 AND s.status IN ('active', 'in_review')
  `, [repoId]);

  // Last stabilization
  const lastStab = await query(`
    SELECT result, stabilized_at FROM gitswarm_stabilizations
    WHERE repo_id = $1 ORDER BY stabilized_at DESC LIMIT 1
  `, [repoId]);

  // Merges since last promotion (buffer ahead of main)
  const lastPromotion = await query(`
    SELECT from_branch, to_branch, promoted_at FROM gitswarm_promotions
    WHERE repo_id = $1 ORDER BY promoted_at DESC LIMIT 1
  `, [repoId]);

  const lastPromotionAt = lastPromotion.rows[0]?.promoted_at || '1970-01-01';
  const mergesSincePromotion = await query(`
    SELECT COUNT(*) as count FROM gitswarm_merges
    WHERE repo_id = $1 AND merged_at > $2
  `, [repoId, lastPromotionAt]);

  // Last merge
  const lastMerge = await query(`
    SELECT m.merged_at, s.name as stream_name
    FROM gitswarm_merges m
    LEFT JOIN gitswarm_streams s ON m.stream_id = s.id
    WHERE m.repo_id = $1 ORDER BY m.merged_at DESC LIMIT 1
  `, [repoId]);

  const counts = streamCounts.rows[0] || {};
  const stabResult = lastStab.rows[0];

  return {
    repo_id: repoId,
    repo_name: repo.name,
    open_streams: parseInt(counts.open_streams) || 0,
    streams_in_review: parseInt(counts.streams_in_review) || 0,
    consensus_pending: pendingConsensus.rows.map((r: any) => r.name || r.id),
    active_agents: activeAgents.rows.map((r: any) => r.name),
    buffer_status: stabResult ? (stabResult.result === 'green' ? 'green' : 'red') : 'unknown',
    buffer_ahead_of_main: parseInt(mergesSincePromotion.rows[0]?.count) || 0,
    last_merge: lastMerge.rows[0] ? {
      stream_name: lastMerge.rows[0].stream_name || 'unknown',
      at: lastMerge.rows[0].merged_at,
    } : null,
    last_stabilization: stabResult ? {
      result: stabResult.result,
      at: stabResult.stabilized_at,
    } : null,
    last_promotion: lastPromotion.rows[0] ? {
      from: lastPromotion.rows[0].from_branch,
      to: lastPromotion.rows[0].to_branch,
      at: lastPromotion.rows[0].promoted_at,
    } : null,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Get state summaries for all active repos.
 */
export async function getAllRepoStates(): Promise<RepoState[]> {
  const repos = await query(
    "SELECT id FROM gitswarm_repos WHERE status = 'active' AND git_backend = 'gitea'"
  );

  const states: RepoState[] = [];
  for (const repo of repos.rows) {
    try {
      states.push(await getRepoState(repo.id));
    } catch {
      // Skip repos that fail to aggregate
    }
  }

  return states;
}
