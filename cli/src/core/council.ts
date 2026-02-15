/**
 * Council governance for local federation.
 *
 * Proposals, voting, and council lifecycle — all database-agnostic.
 *
 * v2 adds git-cascade proposal types: merge_stream, revert_stream,
 * reorder_queue, promote. These delegate to Federation for execution.
 */
import type { SqliteStore } from '../store/sqlite.js';
import type { Federation } from '../federation.js';

export interface CouncilCreateOptions {
  min_karma?: number;
  min_contributions?: number;
  min_members?: number;
  max_members?: number;
  standard_quorum?: number;
  critical_quorum?: number;
}

export interface ProposalCreateData {
  title: string;
  description?: string;
  proposal_type: string;
  action_data?: Record<string, unknown>;
  expires_in_days?: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  required?: number;
  current?: number;
}

export interface VoteResult {
  success: boolean;
  vote: string;
}

export interface ActionResult {
  executed: boolean;
  action?: string;
  reason?: string;
  agent_id?: string;
  error?: string;
  stream_id?: string;
  mergeResult?: unknown;
  settings?: Record<string, unknown>;
  priority?: number;
  success?: boolean;
  from?: string;
  to?: string;
}

export class CouncilService {
  private query: SqliteStore['query'];
  // Set by Federation after construction so council can delegate git ops
  federation: Federation | null;

  constructor(store: SqliteStore) {
    this.query = store.query.bind(store);
    this.federation = null;
  }

  // ── Council lifecycle ────────────────────────────────────

  async create(repoId: string, options: CouncilCreateOptions = {}): Promise<Record<string, unknown>> {
    const {
      min_karma = 1000,
      min_contributions = 5,
      min_members = 3,
      max_members = 9,
      standard_quorum = 2,
      critical_quorum = 3,
    } = options;

    const repo = await this.query(`SELECT id FROM repos WHERE id = ?`, [repoId]);
    if (repo.rows.length === 0) throw new Error('Repository not found');

    const result = await this.query(
      `INSERT INTO repo_councils (repo_id, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'forming')
       ON CONFLICT (repo_id) DO UPDATE SET
         min_karma = ?, min_contributions = ?, min_members = ?, max_members = ?,
         standard_quorum = ?, critical_quorum = ?, updated_at = datetime('now')
       RETURNING *`,
      [repoId, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum,
       min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum]
    );

    return result.rows[0];
  }

  async getCouncil(repoId: string): Promise<Record<string, unknown> | null> {
    const r = await this.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = c.id) as member_count
       FROM repo_councils c WHERE c.repo_id = ?`,
      [repoId]
    );
    return r.rows[0] || null;
  }

  async getMembers(councilId: string): Promise<Record<string, unknown>[]> {
    const r = await this.query(
      `SELECT cm.*, a.name as agent_name, a.karma
       FROM council_members cm
       JOIN agents a ON cm.agent_id = a.id
       WHERE cm.council_id = ?
       ORDER BY cm.role = 'chair' DESC, cm.joined_at`,
      [councilId]
    );
    return r.rows;
  }

  // ── Membership ───────────────────────────────────────────

  async checkEligibility(agentId: string, repoId: string): Promise<EligibilityResult> {
    const council = await this.getCouncil(repoId);
    if (!council) return { eligible: false, reason: 'no_council' };

    const agent = await this.query(`SELECT karma FROM agents WHERE id = ?`, [agentId]);
    if (agent.rows.length === 0) return { eligible: false, reason: 'agent_not_found' };
    if ((agent.rows[0].karma as number) < (council.min_karma as number)) {
      return { eligible: false, reason: 'insufficient_karma', required: council.min_karma as number, current: agent.rows[0].karma as number };
    }

    const contribs = await this.query(
      `SELECT COUNT(*) as c FROM patches WHERE repo_id = ? AND author_id = ? AND status = 'merged'`,
      [repoId, agentId]
    );
    if (parseInt(contribs.rows[0].c as string) < (council.min_contributions as number)) {
      return { eligible: false, reason: 'insufficient_contributions', required: council.min_contributions as number, current: parseInt(contribs.rows[0].c as string) };
    }

    const membership = await this.query(
      `SELECT 1 FROM council_members WHERE council_id = ? AND agent_id = ?`,
      [council.id, agentId]
    );
    if (membership.rows.length > 0) return { eligible: false, reason: 'already_member' };

    const count = await this.query(
      `SELECT COUNT(*) as c FROM council_members WHERE council_id = ?`, [council.id]
    );
    if (parseInt(count.rows[0].c as string) >= (council.max_members as number)) return { eligible: false, reason: 'council_full' };

    return { eligible: true };
  }

  async addMember(councilId: string, agentId: string, role: string = 'member'): Promise<Record<string, unknown>> {
    const result = await this.query(
      `INSERT INTO council_members (council_id, agent_id, role) VALUES (?, ?, ?)
       ON CONFLICT (council_id, agent_id) DO UPDATE SET role = ?
       RETURNING *`,
      [councilId, agentId, role, role]
    );
    await this._updateStatus(councilId);
    return result.rows[0];
  }

  async removeMember(councilId: string, agentId: string): Promise<Record<string, unknown>> {
    const r = await this.query(
      `DELETE FROM council_members WHERE council_id = ? AND agent_id = ? RETURNING *`,
      [councilId, agentId]
    );
    if (r.rows.length === 0) throw new Error('Member not found');
    await this._updateStatus(councilId);
    return r.rows[0];
  }

  // ── Proposals ────────────────────────────────────────────

  async createProposal(councilId: string, proposedBy: string, data: ProposalCreateData): Promise<Record<string, unknown>> {
    const { title, description = '', proposal_type, action_data = {}, expires_in_days = 7 } = data;

    const council = await this.query(`SELECT * FROM repo_councils WHERE id = ?`, [councilId]);
    if (council.rows.length === 0) throw new Error('Council not found');

    const critical = [
      'change_ownership', 'change_settings', 'remove_maintainer',
      'revert_stream', 'promote'
    ];
    const quorum = critical.includes(proposal_type)
      ? council.rows[0].critical_quorum
      : council.rows[0].standard_quorum;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expires_in_days);

    const result = await this.query(
      `INSERT INTO council_proposals (council_id, title, description, proposal_type, proposed_by, quorum_required, expires_at, action_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [councilId, title, description, proposal_type, proposedBy, quorum, expiresAt.toISOString(), JSON.stringify(action_data)]
    );

    await this.query(
      `UPDATE council_members SET proposals_made = proposals_made + 1
       WHERE council_id = ? AND agent_id = ?`,
      [councilId, proposedBy]
    );

    return result.rows[0];
  }

  async vote(proposalId: string, agentId: string, vote: string, comment: string | null = null): Promise<VoteResult> {
    const proposal = await this.query(
      `SELECT p.*, c.id as council_id FROM council_proposals p
       JOIN repo_councils c ON p.council_id = c.id WHERE p.id = ?`,
      [proposalId]
    );
    if (proposal.rows.length === 0) throw new Error('Proposal not found');
    if (proposal.rows[0].status !== 'open') throw new Error(`Proposal is ${proposal.rows[0].status}`);
    if (new Date(proposal.rows[0].expires_at as string) < new Date()) throw new Error('Proposal has expired');

    const membership = await this.query(
      `SELECT 1 FROM council_members WHERE council_id = ? AND agent_id = ?`,
      [proposal.rows[0].council_id, agentId]
    );
    if (membership.rows.length === 0) throw new Error('Only council members can vote');

    // BUG-10 fix: Check for existing vote before UPSERT to avoid inflating votes_cast
    const existingVote = await this.query(
      `SELECT id FROM council_votes WHERE proposal_id = ? AND agent_id = ?`,
      [proposalId, agentId]
    );
    const isNewVote = existingVote.rows.length === 0;

    await this.query(
      `INSERT INTO council_votes (proposal_id, agent_id, vote, comment) VALUES (?, ?, ?, ?)
       ON CONFLICT (proposal_id, agent_id) DO UPDATE SET vote = ?, comment = ?, voted_at = datetime('now')`,
      [proposalId, agentId, vote, comment, vote, comment]
    );

    // Recount
    const votes = await this.query(
      `SELECT vote, COUNT(*) as c FROM council_votes WHERE proposal_id = ? GROUP BY vote`,
      [proposalId]
    );
    const counts: Record<string, number> = { for: 0, against: 0, abstain: 0 };
    for (const v of votes.rows) counts[v.vote as string] = parseInt(v.c as string);

    await this.query(
      `UPDATE council_proposals SET votes_for = ?, votes_against = ?, votes_abstain = ? WHERE id = ?`,
      [counts.for, counts.against, counts.abstain, proposalId]
    );

    // Only increment votes_cast for new votes, not updates
    if (isNewVote) {
      await this.query(
        `UPDATE council_members SET votes_cast = votes_cast + 1
         WHERE council_id = ? AND agent_id = ?`,
        [proposal.rows[0].council_id, agentId]
      );
    }

    // Check resolution
    await this._checkResolution(proposalId);

    return { success: true, vote };
  }

  async listProposals(councilId: string, status: string | null = null): Promise<Record<string, unknown>[]> {
    let sql = `SELECT p.*, a.name as proposer_name FROM council_proposals p
               LEFT JOIN agents a ON p.proposed_by = a.id WHERE p.council_id = ?`;
    const params: unknown[] = [councilId];
    if (status) { sql += ` AND p.status = ?`; params.push(status); }
    sql += ` ORDER BY p.proposed_at DESC`;
    return (await this.query(sql, params)).rows;
  }

  // ── Internal ─────────────────────────────────────────────

  private async _updateStatus(councilId: string): Promise<void> {
    const council = await this.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = c.id) as member_count
       FROM repo_councils c WHERE c.id = ?`,
      [councilId]
    );
    if (council.rows.length === 0) return;
    const { member_count, min_members, status } = council.rows[0] as {
      member_count: number | string;
      min_members: number;
      status: string;
    };
    const count = parseInt(member_count as string);

    let next = status;
    if (count >= min_members && status === 'forming') next = 'active';
    else if (count < min_members && status === 'active') next = 'forming';

    if (next !== status) {
      await this.query(
        `UPDATE repo_councils SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [next, councilId]
      );
    }
  }

  private async _checkResolution(proposalId: string): Promise<string | null> {
    const p = await this.query(
      `SELECT p.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = p.council_id) as total_members
       FROM council_proposals p WHERE p.id = ?`,
      [proposalId]
    );
    if (p.rows.length === 0 || p.rows[0].status !== 'open') return null;

    const { votes_for, votes_against, quorum_required, expires_at } = p.rows[0] as {
      votes_for: number;
      votes_against: number;
      quorum_required: number;
      expires_at: string;
    };
    const total = votes_for + votes_against;

    if (total >= quorum_required) {
      // BUG-9 fix: Explicit tie handling — ties are rejected with distinct reason
      const isTie = votes_for === votes_against;
      const outcome = votes_for > votes_against ? 'passed' : 'rejected';
      const resolution = isTie
        ? JSON.stringify({ reason: 'tie', votes_for, votes_against })
        : null;
      await this.query(
        `UPDATE council_proposals SET status = ?, resolved_at = datetime('now'), execution_result = COALESCE(?, execution_result) WHERE id = ?`,
        [outcome, resolution, proposalId]
      );
      if (outcome === 'passed') await this._executeAction(p.rows[0] as Record<string, unknown>);
      return outcome;
    }

    if (new Date(expires_at) < new Date()) {
      await this.query(
        `UPDATE council_proposals SET status = 'expired', resolved_at = datetime('now') WHERE id = ?`,
        [proposalId]
      );
      return 'expired';
    }
    return null;
  }

  private async _executeAction(proposal: Record<string, unknown>): Promise<void> {
    const { id, council_id, proposal_type, action_data } = proposal;
    const data = typeof action_data === 'string' ? JSON.parse(action_data) as Record<string, unknown> : action_data as Record<string, unknown>;

    const council = await this.query(
      `SELECT repo_id FROM repo_councils WHERE id = ?`, [council_id]
    );
    if (council.rows.length === 0) return;
    const repoId = council.rows[0].repo_id as string;

    let result: ActionResult = { executed: false, reason: 'unsupported' };

    switch (proposal_type) {
      case 'add_maintainer':
        await this.query(
          `INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, ?)
           ON CONFLICT (repo_id, agent_id) DO UPDATE SET role = ?`,
          [repoId, data.agent_id, data.role || 'maintainer', data.role || 'maintainer']
        );
        result = { executed: true, action: 'add_maintainer', agent_id: data.agent_id as string };
        break;

      case 'remove_maintainer':
        await this.query(
          `DELETE FROM maintainers WHERE repo_id = ? AND agent_id = ?`,
          [repoId, data.agent_id]
        );
        result = { executed: true, action: 'remove_maintainer', agent_id: data.agent_id as string };
        break;

      case 'modify_access':
        await this.query(
          `INSERT INTO repo_access (repo_id, agent_id, access_level) VALUES (?, ?, ?)
           ON CONFLICT (repo_id, agent_id) DO UPDATE SET access_level = ?`,
          [repoId, data.agent_id, data.access_level, data.access_level]
        );
        result = { executed: true, action: 'modify_access' };
        break;

      case 'change_settings':
        // Generic repo settings update via action_data.settings
        if (data.settings) {
          for (const [key, value] of Object.entries(data.settings as Record<string, unknown>)) {
            const safeKeys = ['merge_mode', 'ownership_model', 'consensus_threshold',
              'min_reviews', 'agent_access', 'min_karma', 'auto_promote_on_green',
              'auto_revert_on_red', 'stabilize_command'];
            if (safeKeys.includes(key)) {
              await this.query(`UPDATE repos SET ${key} = ? WHERE id = ?`, [value, repoId]);
            }
          }
          result = { executed: true, action: 'change_settings', settings: data.settings as Record<string, unknown> };
        }
        break;

      // ── git-cascade proposal types ─────────────────────

      case 'merge_stream':
        if (this.federation) {
          try {
            const mergeResult = await this.federation.mergeToBuffer(data.stream_id as string, (data.agent_id as string) || 'council');
            result = { executed: true, action: 'merge_stream', stream_id: data.stream_id as string, mergeResult };
          } catch (err) {
            result = { executed: false, action: 'merge_stream', error: (err as Error).message };
          }
        } else {
          result = { executed: false, reason: 'no_federation_ref' };
        }
        break;

      case 'revert_stream':
        if (this.federation && this.federation.tracker) {
          try {
            // Find the merge operation for this stream and roll it back
            const ops = this.federation.tracker.getOperations({ streamId: data.stream_id });
            const mergeOp = ops.find((op: Record<string, unknown>) => op.opType === 'merge');
            if (mergeOp) {
              this.federation.tracker.rollbackToOperation({
                operationId: mergeOp.id,
                streamId: data.stream_id,
                agentId: 'council',
                worktree: this.federation.repoPath
              });
              result = { executed: true, action: 'revert_stream', stream_id: data.stream_id as string };
            } else {
              result = { executed: false, reason: 'no_merge_operation_found' };
            }
          } catch (err) {
            result = { executed: false, action: 'revert_stream', error: (err as Error).message };
          }
        } else {
          result = { executed: false, reason: 'no_federation_ref' };
        }
        break;

      case 'reorder_queue':
        if (this.federation && this.federation.tracker) {
          try {
            // Update merge queue priority for a stream
            const entries = this.federation.tracker.getMergeQueue({ status: 'pending' });
            const entry = entries.find((e: Record<string, unknown>) => e.streamId === data.stream_id);
            if (entry) {
              // Remove and re-add with new priority
              this.federation.tracker.cancelMergeQueueEntry(entry.id);
              this.federation.tracker.addToMergeQueue({
                streamId: data.stream_id,
                targetBranch: entry.targetBranch,
                priority: data.priority || 0,
                agentId: 'council'
              });
              result = { executed: true, action: 'reorder_queue', stream_id: data.stream_id as string, priority: data.priority as number };
            } else {
              result = { executed: false, reason: 'stream_not_in_queue' };
            }
          } catch (err) {
            result = { executed: false, action: 'reorder_queue', error: (err as Error).message };
          }
        } else {
          result = { executed: false, reason: 'no_federation_ref' };
        }
        break;

      case 'promote':
        if (this.federation) {
          try {
            const promoteResult = await this.federation.promote({ tag: data.tag as string | undefined });
            result = { executed: true, action: 'promote', ...promoteResult };
          } catch (err) {
            result = { executed: false, action: 'promote', error: (err as Error).message };
          }
        } else {
          result = { executed: false, reason: 'no_federation_ref' };
        }
        break;
    }

    await this.query(
      `UPDATE council_proposals SET executed = 1, executed_at = datetime('now'), execution_result = ? WHERE id = ?`,
      [JSON.stringify(result), id]
    );
  }
}
