/**
 * Council governance for local federation.
 *
 * Proposals, voting, and council lifecycle — all database-agnostic.
 */
export class CouncilService {
  constructor(store) {
    this.query = store.query.bind(store);
  }

  // ── Council lifecycle ────────────────────────────────────

  async create(repoId, options = {}) {
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

  async getCouncil(repoId) {
    const r = await this.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = c.id) as member_count
       FROM repo_councils c WHERE c.repo_id = ?`,
      [repoId]
    );
    return r.rows[0] || null;
  }

  async getMembers(councilId) {
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

  async checkEligibility(agentId, repoId) {
    const council = await this.getCouncil(repoId);
    if (!council) return { eligible: false, reason: 'no_council' };

    const agent = await this.query(`SELECT karma FROM agents WHERE id = ?`, [agentId]);
    if (agent.rows.length === 0) return { eligible: false, reason: 'agent_not_found' };
    if (agent.rows[0].karma < council.min_karma) {
      return { eligible: false, reason: 'insufficient_karma', required: council.min_karma, current: agent.rows[0].karma };
    }

    const contribs = await this.query(
      `SELECT COUNT(*) as c FROM patches WHERE repo_id = ? AND author_id = ? AND status = 'merged'`,
      [repoId, agentId]
    );
    if (parseInt(contribs.rows[0].c) < council.min_contributions) {
      return { eligible: false, reason: 'insufficient_contributions', required: council.min_contributions, current: parseInt(contribs.rows[0].c) };
    }

    const membership = await this.query(
      `SELECT 1 FROM council_members WHERE council_id = ? AND agent_id = ?`,
      [council.id, agentId]
    );
    if (membership.rows.length > 0) return { eligible: false, reason: 'already_member' };

    const count = await this.query(
      `SELECT COUNT(*) as c FROM council_members WHERE council_id = ?`, [council.id]
    );
    if (parseInt(count.rows[0].c) >= council.max_members) return { eligible: false, reason: 'council_full' };

    return { eligible: true };
  }

  async addMember(councilId, agentId, role = 'member') {
    const result = await this.query(
      `INSERT INTO council_members (council_id, agent_id, role) VALUES (?, ?, ?)
       ON CONFLICT (council_id, agent_id) DO UPDATE SET role = ?
       RETURNING *`,
      [councilId, agentId, role, role]
    );
    await this._updateStatus(councilId);
    return result.rows[0];
  }

  async removeMember(councilId, agentId) {
    const r = await this.query(
      `DELETE FROM council_members WHERE council_id = ? AND agent_id = ? RETURNING *`,
      [councilId, agentId]
    );
    if (r.rows.length === 0) throw new Error('Member not found');
    await this._updateStatus(councilId);
    return r.rows[0];
  }

  // ── Proposals ────────────────────────────────────────────

  async createProposal(councilId, proposedBy, data) {
    const { title, description = '', proposal_type, action_data = {}, expires_in_days = 7 } = data;

    const council = await this.query(`SELECT * FROM repo_councils WHERE id = ?`, [councilId]);
    if (council.rows.length === 0) throw new Error('Council not found');

    const critical = ['change_ownership', 'change_settings', 'remove_maintainer'];
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

  async vote(proposalId, agentId, vote, comment = null) {
    const proposal = await this.query(
      `SELECT p.*, c.id as council_id FROM council_proposals p
       JOIN repo_councils c ON p.council_id = c.id WHERE p.id = ?`,
      [proposalId]
    );
    if (proposal.rows.length === 0) throw new Error('Proposal not found');
    if (proposal.rows[0].status !== 'open') throw new Error(`Proposal is ${proposal.rows[0].status}`);
    if (new Date(proposal.rows[0].expires_at) < new Date()) throw new Error('Proposal has expired');

    const membership = await this.query(
      `SELECT 1 FROM council_members WHERE council_id = ? AND agent_id = ?`,
      [proposal.rows[0].council_id, agentId]
    );
    if (membership.rows.length === 0) throw new Error('Only council members can vote');

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
    const counts = { for: 0, against: 0, abstain: 0 };
    for (const v of votes.rows) counts[v.vote] = parseInt(v.c);

    await this.query(
      `UPDATE council_proposals SET votes_for = ?, votes_against = ?, votes_abstain = ? WHERE id = ?`,
      [counts.for, counts.against, counts.abstain, proposalId]
    );

    await this.query(
      `UPDATE council_members SET votes_cast = votes_cast + 1
       WHERE council_id = ? AND agent_id = ?`,
      [proposal.rows[0].council_id, agentId]
    );

    // Check resolution
    await this._checkResolution(proposalId);

    return { success: true, vote };
  }

  async listProposals(councilId, status = null) {
    let sql = `SELECT p.*, a.name as proposer_name FROM council_proposals p
               LEFT JOIN agents a ON p.proposed_by = a.id WHERE p.council_id = ?`;
    const params = [councilId];
    if (status) { sql += ` AND p.status = ?`; params.push(status); }
    sql += ` ORDER BY p.proposed_at DESC`;
    return (await this.query(sql, params)).rows;
  }

  // ── Internal ─────────────────────────────────────────────

  async _updateStatus(councilId) {
    const council = await this.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = c.id) as member_count
       FROM repo_councils c WHERE c.id = ?`,
      [councilId]
    );
    if (council.rows.length === 0) return;
    const { member_count, min_members, status } = council.rows[0];
    const count = parseInt(member_count);

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

  async _checkResolution(proposalId) {
    const p = await this.query(
      `SELECT p.*,
         (SELECT COUNT(*) FROM council_members WHERE council_id = p.council_id) as total_members
       FROM council_proposals p WHERE p.id = ?`,
      [proposalId]
    );
    if (p.rows.length === 0 || p.rows[0].status !== 'open') return null;

    const { votes_for, votes_against, quorum_required, expires_at } = p.rows[0];
    const total = votes_for + votes_against;

    if (total >= quorum_required) {
      const outcome = votes_for > votes_against ? 'passed' : 'rejected';
      await this.query(
        `UPDATE council_proposals SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
        [outcome, proposalId]
      );
      if (outcome === 'passed') await this._executeAction(p.rows[0]);
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

  async _executeAction(proposal) {
    const { id, council_id, proposal_type, action_data } = proposal;
    const data = typeof action_data === 'string' ? JSON.parse(action_data) : action_data;

    const council = await this.query(
      `SELECT repo_id FROM repo_councils WHERE id = ?`, [council_id]
    );
    if (council.rows.length === 0) return;
    const repoId = council.rows[0].repo_id;

    let result = { executed: false, reason: 'unsupported' };

    switch (proposal_type) {
      case 'add_maintainer':
        await this.query(
          `INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, ?)
           ON CONFLICT (repo_id, agent_id) DO UPDATE SET role = ?`,
          [repoId, data.agent_id, data.role || 'maintainer', data.role || 'maintainer']
        );
        result = { executed: true, action: 'add_maintainer', agent_id: data.agent_id };
        break;

      case 'remove_maintainer':
        await this.query(
          `DELETE FROM maintainers WHERE repo_id = ? AND agent_id = ?`,
          [repoId, data.agent_id]
        );
        result = { executed: true, action: 'remove_maintainer', agent_id: data.agent_id };
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
        break;
    }

    await this.query(
      `UPDATE council_proposals SET executed = 1, executed_at = datetime('now'), execution_result = ? WHERE id = ?`,
      [JSON.stringify(result), id]
    );
  }
}
