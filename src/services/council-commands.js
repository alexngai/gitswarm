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

    // Check contributions to this repo (merged streams)
    const contributions = await this.query(`
      SELECT COUNT(*) as count FROM gitswarm_streams s
      WHERE s.repo_id = $1 AND s.agent_id = $2 AND s.status = 'merged'
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
    const criticalTypes = ['change_ownership', 'change_settings', 'remove_maintainer', 'revert_stream'];
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
        case 'merge_stream':
          result = await this.executeMergeStream(repoId, action_data);
          break;
        case 'revert_stream':
          result = await this.executeRevertStream(repoId, action_data);
          break;
        case 'promote':
          result = await this.executePromote(repoId, action_data);
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

  async executeMergeStream(repoId, data) {
    const { stream_id } = data;
    // Mark stream as approved for merge by council
    await this.query(`
      UPDATE gitswarm_streams SET review_status = 'approved', updated_at = NOW()
      WHERE id = $1 AND repo_id = $2
    `, [stream_id, repoId]);
    return { executed: true, action: 'merge_stream', stream_id };
  }

  async executeRevertStream(repoId, data) {
    const { stream_id } = data;
    // Mark stream for revert
    await this.query(`
      UPDATE gitswarm_streams SET status = 'reverted', updated_at = NOW()
      WHERE id = $1 AND repo_id = $2
    `, [stream_id, repoId]);
    return { executed: true, action: 'revert_stream', stream_id };
  }

  async executePromote(repoId, data) {
    // Record that council approved promotion
    await this.query(`
      INSERT INTO gitswarm_promotions (repo_id, from_branch, to_branch, triggered_by)
      SELECT id, buffer_branch, promote_target, 'council'
      FROM gitswarm_repos WHERE id = $1
    `, [repoId]);
    return { executed: true, action: 'promote' };
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
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { error: 'No council exists for this repository' };
    }

    // Parse nomineeRef - could be @username or agent UUID
    let nomineeId = nomineeRef;
    if (nomineeRef.startsWith('@')) {
      // Look up agent by name
      const agent = await this.query(`
        SELECT id FROM agents WHERE name = $1
      `, [nomineeRef.substring(1)]);

      if (agent.rows.length === 0) {
        return { error: `Agent not found: ${nomineeRef}` };
      }
      nomineeId = agent.rows[0].id;
    }

    // Check eligibility
    const eligibility = await this.checkEligibility(nomineeId, repoId);
    if (!eligibility.eligible) {
      return {
        error: `Agent not eligible for council: ${eligibility.reason}`,
        details: eligibility
      };
    }

    // Add member
    try {
      const member = await this.addMember(council.id, nomineeId, 'member');
      return {
        success: true,
        message: `Successfully nominated agent to council`,
        member: {
          agent_id: nomineeId,
          role: member.role,
          joined_at: member.joined_at
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async commandVote(repoId, voterId, proposalRef, voteValue) {
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { error: 'No council exists for this repository' };
    }

    // Parse vote value
    const voteMap = {
      'yes': 'for',
      'no': 'against',
      'for': 'for',
      'against': 'against',
      'abstain': 'abstain'
    };

    const vote = voteMap[voteValue?.toLowerCase()];
    if (!vote) {
      return { error: `Invalid vote value: ${voteValue}. Use yes/no/abstain` };
    }

    // Find the proposal - proposalRef could be ID or #number
    let proposalId = proposalRef;
    if (proposalRef.startsWith('#')) {
      // Find by recent proposal number (order by created)
      const proposals = await this.query(`
        SELECT id FROM gitswarm_council_proposals
        WHERE council_id = $1 AND status = 'open'
        ORDER BY proposed_at DESC
      `, [council.id]);

      const index = parseInt(proposalRef.substring(1)) - 1;
      if (index < 0 || index >= proposals.rows.length) {
        return { error: `Proposal not found: ${proposalRef}` };
      }
      proposalId = proposals.rows[index].id;
    }

    try {
      const result = await this.vote(proposalId, voterId, vote);

      // Get updated proposal status
      const proposal = await this.query(`
        SELECT title, status, votes_for, votes_against, quorum_required
        FROM gitswarm_council_proposals WHERE id = $1
      `, [proposalId]);

      return {
        success: true,
        message: `Vote '${vote}' recorded`,
        proposal: {
          title: proposal.rows[0].title,
          status: proposal.rows[0].status,
          votes_for: proposal.rows[0].votes_for,
          votes_against: proposal.rows[0].votes_against,
          quorum_required: proposal.rows[0].quorum_required
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async commandPropose(repoId, proposerId, args) {
    const council = await this.getCouncil(repoId);
    if (!council) {
      return { error: 'No council exists for this repository' };
    }

    // Check if proposer is a member
    const membership = await this.query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2
    `, [council.id, proposerId]);

    if (membership.rows.length === 0) {
      return { error: 'Only council members can create proposals' };
    }

    // Parse command: /council propose <type> <title> [description]
    // E.g., /council propose add_maintainer "Add @agent as maintainer" "They have contributed significantly"
    if (args.length < 2) {
      return {
        error: 'Usage: /council propose <type> <title> [description]',
        types: ['add_maintainer', 'remove_maintainer', 'modify_branch_rule',
                'modify_access', 'change_settings', 'merge_stream',
                'revert_stream', 'promote', 'custom']
      };
    }

    const proposalType = args[0];
    const validTypes = ['add_maintainer', 'remove_maintainer', 'modify_branch_rule',
                        'modify_access', 'change_ownership', 'change_settings',
                        'merge_stream', 'revert_stream', 'promote', 'custom'];

    if (!validTypes.includes(proposalType)) {
      return {
        error: `Invalid proposal type: ${proposalType}`,
        types: validTypes
      };
    }

    // Join remaining args as title (handle quoted strings)
    const remainingText = args.slice(1).join(' ');

    // Try to parse quoted title and description
    const quotedMatch = remainingText.match(/^"([^"]+)"(?:\s+"([^"]+)")?/);
    let title, description;

    if (quotedMatch) {
      title = quotedMatch[1];
      description = quotedMatch[2] || '';
    } else {
      title = remainingText;
      description = '';
    }

    try {
      const proposal = await this.createProposal(council.id, proposerId, {
        title,
        description,
        proposal_type: proposalType,
        expires_in_days: 7
      });

      return {
        success: true,
        message: 'Proposal created',
        proposal: {
          id: proposal.id,
          title: proposal.title,
          type: proposal.proposal_type,
          quorum_required: proposal.quorum_required,
          expires_at: proposal.expires_at
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ============================================================
  // Elections
  // ============================================================

  /**
   * Start a new council election
   */
  async startElection(councilId, creatorId, options = {}) {
    const {
      election_type = 'regular',
      seats_available = 1,
      nominations_days = 7,
      voting_days = 7
    } = options;

    // Check council exists and is active
    const council = await this.query(`
      SELECT * FROM gitswarm_repo_councils WHERE id = $1
    `, [councilId]);

    if (council.rows.length === 0) {
      throw new Error('Council not found');
    }

    // Check no active election
    const activeElection = await this.query(`
      SELECT id FROM gitswarm_council_elections
      WHERE council_id = $1 AND status IN ('nominations', 'voting')
    `, [councilId]);

    if (activeElection.rows.length > 0) {
      throw new Error('An election is already in progress');
    }

    // Calculate dates
    const nominationsEndAt = new Date();
    nominationsEndAt.setDate(nominationsEndAt.getDate() + nominations_days);

    const votingStartAt = new Date(nominationsEndAt);
    const votingEndAt = new Date(votingStartAt);
    votingEndAt.setDate(votingEndAt.getDate() + voting_days);

    // Create election
    const result = await this.query(`
      INSERT INTO gitswarm_council_elections (
        council_id, election_type, seats_available, status,
        nominations_end_at, voting_start_at, voting_end_at, created_by
      ) VALUES ($1, $2, $3, 'nominations', $4, $5, $6, $7)
      RETURNING *
    `, [councilId, election_type, seats_available, nominationsEndAt, votingStartAt, votingEndAt, creatorId]);

    return result.rows[0];
  }

  /**
   * Get current or recent election
   */
  async getElection(electionId) {
    const result = await this.query(`
      SELECT e.*, c.repo_id
      FROM gitswarm_council_elections e
      JOIN gitswarm_repo_councils c ON e.council_id = c.id
      WHERE e.id = $1
    `, [electionId]);

    return result.rows[0] || null;
  }

  /**
   * Get active election for a council
   */
  async getActiveElection(councilId) {
    const result = await this.query(`
      SELECT * FROM gitswarm_council_elections
      WHERE council_id = $1 AND status IN ('nominations', 'voting')
      ORDER BY created_at DESC
      LIMIT 1
    `, [councilId]);

    return result.rows[0] || null;
  }

  /**
   * Nominate a candidate for election
   */
  async nominateCandidate(electionId, agentId, nominatedBy, statement = null) {
    const election = await this.getElection(electionId);
    if (!election) {
      throw new Error('Election not found');
    }

    if (election.status !== 'nominations') {
      throw new Error('Nominations are closed for this election');
    }

    // Check if agent is eligible (karma, contributions)
    const eligibility = await this.checkEligibility(agentId, election.repo_id);
    if (!eligibility.eligible) {
      throw new Error(`Agent not eligible: ${eligibility.reason}`);
    }

    // Create nomination
    const result = await this.query(`
      INSERT INTO gitswarm_election_candidates (
        election_id, agent_id, nominated_by, statement
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (election_id, agent_id) DO UPDATE SET
        statement = COALESCE($4, gitswarm_election_candidates.statement)
      RETURNING *
    `, [electionId, agentId, nominatedBy, statement]);

    return result.rows[0];
  }

  /**
   * Accept nomination
   */
  async acceptNomination(candidateId, agentId) {
    const result = await this.query(`
      UPDATE gitswarm_election_candidates
      SET status = 'accepted'
      WHERE id = $1 AND agent_id = $2 AND status = 'nominated'
      RETURNING *
    `, [candidateId, agentId]);

    if (result.rows.length === 0) {
      throw new Error('Nomination not found or already processed');
    }

    return result.rows[0];
  }

  /**
   * Withdraw candidacy
   */
  async withdrawCandidacy(candidateId, agentId) {
    const result = await this.query(`
      UPDATE gitswarm_election_candidates
      SET status = 'withdrawn'
      WHERE id = $1 AND agent_id = $2 AND status IN ('nominated', 'accepted')
      RETURNING *
    `, [candidateId, agentId]);

    if (result.rows.length === 0) {
      throw new Error('Candidacy not found or cannot be withdrawn');
    }

    return result.rows[0];
  }

  /**
   * Get candidates for an election
   */
  async getElectionCandidates(electionId) {
    const result = await this.query(`
      SELECT c.*, a.name as agent_name, a.karma, a.avatar_url
      FROM gitswarm_election_candidates c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.election_id = $1 AND c.status IN ('nominated', 'accepted')
      ORDER BY c.vote_count DESC, c.nominated_at
    `, [electionId]);

    return result.rows;
  }

  /**
   * Transition election to voting phase
   */
  async startVoting(electionId) {
    const election = await this.getElection(electionId);
    if (!election) {
      throw new Error('Election not found');
    }

    if (election.status !== 'nominations') {
      throw new Error('Election is not in nominations phase');
    }

    // Check we have enough candidates
    const candidates = await this.getElectionCandidates(electionId);
    if (candidates.length < election.seats_available) {
      throw new Error(`Not enough candidates (${candidates.length}) for ${election.seats_available} seats`);
    }

    // Update status
    await this.query(`
      UPDATE gitswarm_council_elections
      SET status = 'voting', voting_start_at = NOW()
      WHERE id = $1
    `, [electionId]);

    return { success: true, candidates_count: candidates.length };
  }

  /**
   * Cast a vote in an election
   */
  async castElectionVote(electionId, voterId, candidateId) {
    const election = await this.getElection(electionId);
    if (!election) {
      throw new Error('Election not found');
    }

    if (election.status !== 'voting') {
      throw new Error('Voting is not open for this election');
    }

    // Check voter is eligible (council member or eligible contributor)
    const membership = await this.query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2
    `, [election.council_id, voterId]);

    // For now, only council members can vote
    // Could expand to include eligible agents based on settings
    if (membership.rows.length === 0) {
      throw new Error('Only council members can vote in elections');
    }

    // Check candidate exists
    const candidate = await this.query(`
      SELECT id FROM gitswarm_election_candidates
      WHERE id = $1 AND election_id = $2 AND status IN ('nominated', 'accepted')
    `, [candidateId, electionId]);

    if (candidate.rows.length === 0) {
      throw new Error('Candidate not found or not eligible');
    }

    // Check not already voted for this candidate
    const existingVote = await this.query(`
      SELECT id FROM gitswarm_election_votes
      WHERE election_id = $1 AND voter_id = $2 AND candidate_id = $3
    `, [electionId, voterId, candidateId]);

    if (existingVote.rows.length > 0) {
      throw new Error('You have already voted for this candidate');
    }

    // Record vote
    await this.query(`
      INSERT INTO gitswarm_election_votes (election_id, voter_id, candidate_id)
      VALUES ($1, $2, $3)
    `, [electionId, voterId, candidateId]);

    // Update candidate vote count
    await this.query(`
      UPDATE gitswarm_election_candidates
      SET vote_count = vote_count + 1
      WHERE id = $1
    `, [candidateId]);

    return { success: true, voted_for: candidateId };
  }

  /**
   * Complete election and elect winners
   */
  async completeElection(electionId) {
    const election = await this.getElection(electionId);
    if (!election) {
      throw new Error('Election not found');
    }

    if (election.status !== 'voting') {
      throw new Error('Election is not in voting phase');
    }

    // Get candidates sorted by votes
    const candidates = await this.query(`
      SELECT c.*, a.name as agent_name
      FROM gitswarm_election_candidates c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.election_id = $1 AND c.status IN ('nominated', 'accepted')
      ORDER BY c.vote_count DESC
    `, [electionId]);

    const winners = candidates.rows.slice(0, election.seats_available);
    const losers = candidates.rows.slice(election.seats_available);

    // Calculate term expiration
    const council = await this.query(`
      SELECT term_limit_months FROM gitswarm_repo_councils WHERE id = $1
    `, [election.council_id]);

    let termExpiresAt = null;
    if (council.rows[0].term_limit_months) {
      termExpiresAt = new Date();
      termExpiresAt.setMonth(termExpiresAt.getMonth() + council.rows[0].term_limit_months);
    }

    // Update winner statuses and add to council
    for (const winner of winners) {
      await this.query(`
        UPDATE gitswarm_election_candidates SET status = 'elected' WHERE id = $1
      `, [winner.id]);

      // Add or update membership
      await this.query(`
        INSERT INTO gitswarm_council_members (council_id, agent_id, role, term_expires_at)
        VALUES ($1, $2, 'member', $3)
        ON CONFLICT (council_id, agent_id) DO UPDATE SET
          term_expires_at = $3,
          joined_at = NOW()
      `, [election.council_id, winner.agent_id, termExpiresAt]);
    }

    // Update loser statuses
    for (const loser of losers) {
      await this.query(`
        UPDATE gitswarm_election_candidates SET status = 'not_elected' WHERE id = $1
      `, [loser.id]);
    }

    // Complete election
    await this.query(`
      UPDATE gitswarm_council_elections
      SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [electionId]);

    // Update council status if needed
    await this.updateCouncilStatus(election.council_id);

    return {
      success: true,
      winners: winners.map(w => ({ agent_id: w.agent_id, name: w.agent_name, votes: w.vote_count })),
      term_expires_at: termExpiresAt
    };
  }

  /**
   * Get election results
   */
  async getElectionResults(electionId) {
    const election = await this.getElection(electionId);
    if (!election) {
      throw new Error('Election not found');
    }

    const candidates = await this.query(`
      SELECT c.*, a.name as agent_name, a.karma
      FROM gitswarm_election_candidates c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.election_id = $1
      ORDER BY c.vote_count DESC, c.nominated_at
    `, [electionId]);

    const totalVotes = await this.query(`
      SELECT COUNT(DISTINCT voter_id) as count FROM gitswarm_election_votes
      WHERE election_id = $1
    `, [electionId]);

    return {
      election: {
        id: election.id,
        status: election.status,
        seats_available: election.seats_available,
        completed_at: election.completed_at
      },
      candidates: candidates.rows.map(c => ({
        agent_id: c.agent_id,
        name: c.agent_name,
        karma: c.karma,
        vote_count: c.vote_count,
        status: c.status,
        statement: c.statement
      })),
      total_voters: parseInt(totalVotes.rows[0].count)
    };
  }

  /**
   * Check for and handle expired member terms
   */
  async checkExpiredTerms(councilId) {
    // Find members with expired terms
    const expired = await this.query(`
      SELECT agent_id FROM gitswarm_council_members
      WHERE council_id = $1 AND term_expires_at IS NOT NULL AND term_expires_at < NOW()
    `, [councilId]);

    // Remove expired members
    for (const member of expired.rows) {
      await this.removeMember(councilId, member.agent_id);
    }

    return {
      expired_count: expired.rows.length,
      removed: expired.rows.map(m => m.agent_id)
    };
  }
}

// Export singleton instance
export const councilCommands = new CouncilCommandsService();
