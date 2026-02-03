import { query } from '../config/database.js';

/**
 * Council Commands Service
 * Handles parsing and execution of council governance commands
 */
export class CouncilCommandsService {
  constructor(db = null) {
    this.db = db;
    this.query = db?.query || query;
  }

  // ============================================================
  // Council Management
  // ============================================================

  /**
   * Create a council for a repository
   */
  async createCouncil(repoId, options = {}) {
    const {
      min_karma = 1000,
      min_contributions = 5,
      min_members = 3,
      max_members = 9,
      standard_quorum = 2,
      critical_quorum = 3
    } = options;

    // Check if repo exists and doesn't have a council
    const repo = await this.query(`
      SELECT id, ownership_model FROM gitswarm_repos WHERE id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      throw new Error('Repository not found');
    }

    // Create the council
    const result = await this.query(`
      INSERT INTO gitswarm_repo_councils (
        repo_id, min_karma, min_contributions, min_members, max_members,
        standard_quorum, critical_quorum, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'forming')
      ON CONFLICT (repo_id) DO UPDATE SET
        min_karma = $2,
        min_contributions = $3,
        min_members = $4,
        max_members = $5,
        standard_quorum = $6,
        critical_quorum = $7,
        updated_at = NOW()
      RETURNING *
    `, [repoId, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum]);

    return result.rows[0];
  }

  /**
   * Get council for a repository
   */
  async getCouncil(repoId) {
    const result = await this.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM gitswarm_council_members WHERE council_id = c.id) as member_count
      FROM gitswarm_repo_councils c
      WHERE c.repo_id = $1
    `, [repoId]);

    return result.rows[0] || null;
  }

  /**
   * Get council members
   */
  async getCouncilMembers(councilId) {
    const result = await this.query(`
      SELECT cm.*, a.name as agent_name, a.karma, a.avatar_url
      FROM gitswarm_council_members cm
      JOIN agents a ON cm.agent_id = a.id
      WHERE cm.council_id = $1
      ORDER BY cm.role = 'chair' DESC, cm.joined_at
    `, [councilId]);

    return result.rows;
  }

  /**
   * Check if an agent is eligible for council membership
   */
  async checkEligibility(agentId, repoId) {
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { eligible: false, reason: 'no_council' };
    }

    // Check karma
    const agent = await this.query(`
      SELECT karma FROM agents WHERE id = $1
    `, [agentId]);

    if (agent.rows.length === 0) {
      return { eligible: false, reason: 'agent_not_found' };
    }

    if (agent.rows[0].karma < council.min_karma) {
      return {
        eligible: false,
        reason: 'insufficient_karma',
        required: council.min_karma,
        current: agent.rows[0].karma
      };
    }

    // Check contributions to this repo
    const contributions = await this.query(`
      SELECT COUNT(*) as count FROM patches p
      JOIN gitswarm_patches gp ON gp.patch_id = p.id
      WHERE gp.repo_id = $1 AND p.author_id = $2 AND p.status = 'merged'
    `, [repoId, agentId]);

    const contributionCount = parseInt(contributions.rows[0].count);
    if (contributionCount < council.min_contributions) {
      return {
        eligible: false,
        reason: 'insufficient_contributions',
        required: council.min_contributions,
        current: contributionCount
      };
    }

    // Check if already a member
    const membership = await this.query(`
      SELECT 1 FROM gitswarm_council_members WHERE council_id = $1 AND agent_id = $2
    `, [council.id, agentId]);

    if (membership.rows.length > 0) {
      return { eligible: false, reason: 'already_member' };
    }

    // Check if council is full
    const memberCount = await this.query(`
      SELECT COUNT(*) as count FROM gitswarm_council_members WHERE council_id = $1
    `, [council.id]);

    if (parseInt(memberCount.rows[0].count) >= council.max_members) {
      return { eligible: false, reason: 'council_full' };
    }

    return { eligible: true };
  }

  /**
   * Add a member to the council
   */
  async addMember(councilId, agentId, role = 'member') {
    const result = await this.query(`
      INSERT INTO gitswarm_council_members (council_id, agent_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (council_id, agent_id) DO UPDATE SET role = $3
      RETURNING *
    `, [councilId, agentId, role]);

    // Update council status if minimum members reached
    await this.updateCouncilStatus(councilId);

    return result.rows[0];
  }

  /**
   * Remove a member from the council
   */
  async removeMember(councilId, agentId) {
    const result = await this.query(`
      DELETE FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2
      RETURNING *
    `, [councilId, agentId]);

    if (result.rows.length === 0) {
      throw new Error('Member not found');
    }

    // Update council status
    await this.updateCouncilStatus(councilId);

    return result.rows[0];
  }

  /**
   * Update council status based on membership
   */
  async updateCouncilStatus(councilId) {
    const council = await this.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM gitswarm_council_members WHERE council_id = c.id) as member_count
      FROM gitswarm_repo_councils c
      WHERE c.id = $1
    `, [councilId]);

    if (council.rows.length === 0) return;

    const { member_count, min_members, status } = council.rows[0];
    const count = parseInt(member_count);

    let newStatus = status;
    if (count >= min_members && status === 'forming') {
      newStatus = 'active';
    } else if (count < min_members && status === 'active') {
      newStatus = 'forming';
    }

    if (newStatus !== status) {
      await this.query(`
        UPDATE gitswarm_repo_councils SET status = $1, updated_at = NOW()
        WHERE id = $2
      `, [newStatus, councilId]);
    }
  }

  // ============================================================
  // Proposals
  // ============================================================

  /**
   * Create a proposal
   */
  async createProposal(councilId, proposedBy, data) {
    const {
      title,
      description,
      proposal_type,
      action_data = {},
      expires_in_days = 7
    } = data;

    // Get council to determine quorum
    const council = await this.query(`
      SELECT * FROM gitswarm_repo_councils WHERE id = $1
    `, [councilId]);

    if (council.rows.length === 0) {
      throw new Error('Council not found');
    }

    // Determine quorum based on proposal type
    const criticalTypes = ['change_ownership', 'change_settings', 'remove_maintainer'];
    const quorum = criticalTypes.includes(proposal_type)
      ? council.rows[0].critical_quorum
      : council.rows[0].standard_quorum;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expires_in_days);

    const result = await this.query(`
      INSERT INTO gitswarm_council_proposals (
        council_id, title, description, proposal_type, proposed_by,
        quorum_required, expires_at, action_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [councilId, title, description, proposal_type, proposedBy, quorum, expiresAt, JSON.stringify(action_data)]);

    // Update proposer stats
    await this.query(`
      UPDATE gitswarm_council_members
      SET proposals_made = proposals_made + 1
      WHERE council_id = $1 AND agent_id = $2
    `, [councilId, proposedBy]);

    return result.rows[0];
  }

  /**
   * Vote on a proposal
   */
  async vote(proposalId, agentId, vote, comment = null) {
    // Check proposal exists and is open
    const proposal = await this.query(`
      SELECT p.*, c.id as council_id
      FROM gitswarm_council_proposals p
      JOIN gitswarm_repo_councils c ON p.council_id = c.id
      WHERE p.id = $1
    `, [proposalId]);

    if (proposal.rows.length === 0) {
      throw new Error('Proposal not found');
    }

    if (proposal.rows[0].status !== 'open') {
      throw new Error(`Proposal is ${proposal.rows[0].status}`);
    }

    if (new Date(proposal.rows[0].expires_at) < new Date()) {
      throw new Error('Proposal has expired');
    }

    // Check voter is a council member
    const membership = await this.query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2
    `, [proposal.rows[0].council_id, agentId]);

    if (membership.rows.length === 0) {
      throw new Error('Only council members can vote');
    }

    // Cast vote
    await this.query(`
      INSERT INTO gitswarm_council_votes (proposal_id, agent_id, vote, comment)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (proposal_id, agent_id) DO UPDATE SET
        vote = $3,
        comment = $4,
        voted_at = NOW()
    `, [proposalId, agentId, vote, comment]);

    // Update vote counts
    const votes = await this.query(`
      SELECT vote, COUNT(*) as count
      FROM gitswarm_council_votes
      WHERE proposal_id = $1
      GROUP BY vote
    `, [proposalId]);

    const voteCounts = { for: 0, against: 0, abstain: 0 };
    for (const v of votes.rows) {
      voteCounts[v.vote] = parseInt(v.count);
    }

    await this.query(`
      UPDATE gitswarm_council_proposals SET
        votes_for = $1,
        votes_against = $2,
        votes_abstain = $3
      WHERE id = $4
    `, [voteCounts.for, voteCounts.against, voteCounts.abstain, proposalId]);

    // Update voter stats
    await this.query(`
      UPDATE gitswarm_council_members
      SET votes_cast = votes_cast + 1
      WHERE council_id = $1 AND agent_id = $2
    `, [proposal.rows[0].council_id, agentId]);

    // Check if proposal should be resolved
    await this.checkProposalResolution(proposalId);

    return { success: true, vote };
  }

  /**
   * Check if a proposal should be resolved (passed or rejected)
   */
  async checkProposalResolution(proposalId) {
    const proposal = await this.query(`
      SELECT p.*, c.id as council_id,
        (SELECT COUNT(*) FROM gitswarm_council_members WHERE council_id = c.id) as total_members
      FROM gitswarm_council_proposals p
      JOIN gitswarm_repo_councils c ON p.council_id = c.id
      WHERE p.id = $1
    `, [proposalId]);

    if (proposal.rows.length === 0 || proposal.rows[0].status !== 'open') {
      return null;
    }

    const {
      votes_for,
      votes_against,
      quorum_required,
      total_members,
      expires_at
    } = proposal.rows[0];

    const totalVotes = votes_for + votes_against;

    // Check if quorum reached
    if (totalVotes >= quorum_required) {
      if (votes_for > votes_against) {
        // Proposal passed
        await this.resolveProposal(proposalId, 'passed');
        return 'passed';
      } else {
        // Proposal rejected
        await this.resolveProposal(proposalId, 'rejected');
        return 'rejected';
      }
    }

    // Check if expired
    if (new Date(expires_at) < new Date()) {
      await this.resolveProposal(proposalId, 'expired');
      return 'expired';
    }

    return null;
  }

  /**
   * Resolve a proposal and optionally execute its action
   */
  async resolveProposal(proposalId, status) {
    const proposal = await this.query(`
      UPDATE gitswarm_council_proposals SET
        status = $1,
        resolved_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, proposalId]);

    if (proposal.rows.length === 0) {
      throw new Error('Proposal not found');
    }

    // If passed, execute the action
    if (status === 'passed') {
      await this.executeProposalAction(proposal.rows[0]);
    }

    return proposal.rows[0];
  }

  /**
   * Execute a passed proposal's action
   */
  async executeProposalAction(proposal) {
    const { id, council_id, proposal_type, action_data } = proposal;

    let result = null;

    try {
      // Get repo for this council
      const council = await this.query(`
        SELECT repo_id FROM gitswarm_repo_councils WHERE id = $1
      `, [council_id]);

      if (council.rows.length === 0) {
        throw new Error('Council not found');
      }

      const repoId = council.rows[0].repo_id;

      switch (proposal_type) {
        case 'add_maintainer':
          result = await this.executeAddMaintainer(repoId, action_data);
          break;
        case 'remove_maintainer':
          result = await this.executeRemoveMaintainer(repoId, action_data);
          break;
        case 'modify_branch_rule':
          result = await this.executeModifyBranchRule(repoId, action_data);
          break;
        case 'modify_access':
          result = await this.executeModifyAccess(repoId, action_data);
          break;
        case 'change_settings':
          result = await this.executeChangeSettings(repoId, action_data);
          break;
        default:
          result = { executed: false, reason: 'unsupported_action_type' };
      }

      // Record execution
      await this.query(`
        UPDATE gitswarm_council_proposals SET
          executed = true,
          executed_at = NOW(),
          execution_result = $1
        WHERE id = $2
      `, [JSON.stringify(result), id]);

      return result;
    } catch (error) {
      await this.query(`
        UPDATE gitswarm_council_proposals SET
          execution_result = $1
        WHERE id = $2
      `, [JSON.stringify({ error: error.message }), id]);

      throw error;
    }
  }

  // Action executors
  async executeAddMaintainer(repoId, data) {
    const { agent_id, role = 'maintainer' } = data;
    await this.query(`
      INSERT INTO gitswarm_maintainers (repo_id, agent_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (repo_id, agent_id) DO UPDATE SET role = $3
    `, [repoId, agent_id, role]);
    return { executed: true, action: 'add_maintainer', agent_id };
  }

  async executeRemoveMaintainer(repoId, data) {
    const { agent_id } = data;
    await this.query(`
      DELETE FROM gitswarm_maintainers WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agent_id]);
    return { executed: true, action: 'remove_maintainer', agent_id };
  }

  async executeModifyBranchRule(repoId, data) {
    const { rule_id, updates } = data;
    // Implementation would update branch rule
    return { executed: true, action: 'modify_branch_rule', rule_id };
  }

  async executeModifyAccess(repoId, data) {
    const { agent_id, access_level } = data;
    await this.query(`
      INSERT INTO gitswarm_repo_access (repo_id, agent_id, access_level)
      VALUES ($1, $2, $3)
      ON CONFLICT (repo_id, agent_id) DO UPDATE SET access_level = $3
    `, [repoId, agent_id, access_level]);
    return { executed: true, action: 'modify_access', agent_id, access_level };
  }

  async executeChangeSettings(repoId, data) {
    const { settings } = data;
    // Implementation would update repo settings
    return { executed: true, action: 'change_settings', settings };
  }

  // ============================================================
  // Command Parsing
  // ============================================================

  /**
   * Parse a council command from text
   * Commands: /council nominate @agent, /council vote yes/no, etc.
   */
  parseCommand(text) {
    const match = text.match(/^\/council\s+(\w+)(?:\s+(.*))?$/i);
    if (!match) return null;

    const [, command, args] = match;
    const parsedArgs = args ? args.trim().split(/\s+/) : [];

    return {
      command: command.toLowerCase(),
      args: parsedArgs,
      raw: text
    };
  }

  /**
   * Execute a parsed council command
   */
  async executeCommand(parsedCommand, context) {
    const { command, args } = parsedCommand;
    const { agentId, repoId } = context;

    switch (command) {
      case 'status':
        return this.commandStatus(repoId);
      case 'nominate':
        return this.commandNominate(repoId, agentId, args[0]);
      case 'vote':
        return this.commandVote(repoId, agentId, args[0], args[1]);
      case 'propose':
        return this.commandPropose(repoId, agentId, args);
      case 'members':
        return this.commandMembers(repoId);
      default:
        return { error: `Unknown council command: ${command}` };
    }
  }

  async commandStatus(repoId) {
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { message: 'No council exists for this repository' };
    }

    const members = await this.getCouncilMembers(council.id);
    const openProposals = await this.query(`
      SELECT COUNT(*) as count FROM gitswarm_council_proposals
      WHERE council_id = $1 AND status = 'open'
    `, [council.id]);

    return {
      council: {
        status: council.status,
        member_count: members.length,
        min_members: council.min_members,
        max_members: council.max_members,
        open_proposals: parseInt(openProposals.rows[0].count)
      },
      members: members.map(m => ({
        name: m.agent_name,
        role: m.role,
        karma: m.karma
      }))
    };
  }

  async commandMembers(repoId) {
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { message: 'No council exists for this repository' };
    }

    const members = await this.getCouncilMembers(council.id);
    return {
      members: members.map(m => ({
        agent_id: m.agent_id,
        name: m.agent_name,
        role: m.role,
        karma: m.karma,
        votes_cast: m.votes_cast,
        proposals_made: m.proposals_made
      }))
    };
  }

  async commandNominate(repoId, nominatorId, nomineeRef) {
    // Implementation for nominating a council member
    return { message: 'Nomination command not yet implemented' };
  }

  async commandVote(repoId, voterId, proposalRef, voteValue) {
    // Implementation for voting on a proposal
    return { message: 'Vote command not yet implemented' };
  }

  async commandPropose(repoId, proposerId, args) {
    // Implementation for creating a proposal
    return { message: 'Propose command not yet implemented' };
  }
}

// Export singleton instance
export const councilCommands = new CouncilCommandsService();
