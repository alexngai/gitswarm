import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { CouncilCommandsService, councilCommands as defaultCouncilCommands } from '../../services/council-commands.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

/**
 * GitSwarm Council Governance Routes
 */
export async function councilRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService, pluginEngine } = options;
  const councilCommands = options.councilCommands || defaultCouncilCommands;
  const permissionService = new GitSwarmPermissionService();

  const rateLimit = createRateLimiter('default');
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  /**
   * Emit a gitswarm event through the plugin engine (fire-and-forget).
   */
  function emitGitswarmEvent(repoId, eventType, payload) {
    if (!pluginEngine) return;
    pluginEngine.processGitswarmEvent(repoId, eventType, payload)
      .catch(err => console.error(`Gitswarm event ${eventType} failed:`, err.message));
  }

  // ============================================================
  // Council Management
  // ============================================================

  /**
   * Get council for a repository
   */
  app.get('/gitswarm/repos/:repoId/council', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, repoId, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    const council = await councilCommands.getCouncil(repoId);

    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    const members = await councilCommands.getCouncilMembers(council.id);

    // Get open proposals count
    const openProposals = await query(`
      SELECT COUNT(*) as count FROM gitswarm_council_proposals
      WHERE council_id = $1 AND status = 'open'
    `, [council.id]);

    return {
      council: {
        id: council.id,
        repo_id: council.repo_id,
        status: council.status,
        min_karma: council.min_karma,
        min_contributions: council.min_contributions,
        min_members: council.min_members,
        max_members: council.max_members,
        standard_quorum: council.standard_quorum,
        critical_quorum: council.critical_quorum,
        election_period_days: council.election_period_days,
        term_limit_months: council.term_limit_months,
        member_count: members.length,
        open_proposals: parseInt(openProposals.rows[0].count),
        created_at: council.created_at,
        updated_at: council.updated_at
      },
      members: members.map(m => ({
        agent_id: m.agent_id,
        name: m.agent_name,
        role: m.role,
        karma: m.karma,
        avatar_url: m.avatar_url,
        joined_at: m.joined_at,
        term_expires_at: m.term_expires_at,
        votes_cast: m.votes_cast,
        proposals_made: m.proposals_made
      }))
    };
  });

  /**
   * Create council for a repository
   */
  app.post('/gitswarm/repos/:repoId/council', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          min_karma: { type: 'integer', minimum: 0 },
          min_contributions: { type: 'integer', minimum: 0 },
          min_members: { type: 'integer', minimum: 1 },
          max_members: { type: 'integer', minimum: 1 },
          standard_quorum: { type: 'integer', minimum: 1 },
          critical_quorum: { type: 'integer', minimum: 1 },
          election_period_days: { type: 'integer', minimum: 1 },
          term_limit_months: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    // Check if agent is owner
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    if (!isOwner) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository owners can create a council'
      });
    }

    // Check if council already exists
    const existing = await councilCommands.getCouncil(repoId);
    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'A council already exists for this repository'
      });
    }

    try {
      const council = await councilCommands.createCouncil(repoId, (request.body as any));

      // Add creator as first member (chair)
      await councilCommands.addMember(council.id, request.agent.id, 'chair');

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_council_created',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { council_id: council.id }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ council });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Update council settings
   */
  app.patch('/gitswarm/repos/:repoId/council', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          min_karma: { type: 'integer', minimum: 0 },
          min_contributions: { type: 'integer', minimum: 0 },
          min_members: { type: 'integer', minimum: 1 },
          max_members: { type: 'integer', minimum: 1 },
          standard_quorum: { type: 'integer', minimum: 1 },
          critical_quorum: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is council chair or repo owner
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isChair = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2 AND role = 'chair'
    `, [council.id, request.agent.id]);

    if (!isOwner && isChair.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the council chair or repository owner can update council settings'
      });
    }

    const allowedFields = [
      'min_karma', 'min_contributions', 'min_members', 'max_members',
      'standard_quorum', 'critical_quorum'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if ((request.body as any)[field] !== undefined) {
        updates.push(`${field} = $${paramIndex++}`);
        values.push((request.body as any)[field]);
      }
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No updates provided'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(council.id);

    const result = await query(`
      UPDATE gitswarm_repo_councils SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    return { council: result.rows[0] };
  });

  // ============================================================
  // Council Members
  // ============================================================

  /**
   * List council members
   */
  app.get('/gitswarm/repos/:repoId/council/members', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    const members = await councilCommands.getCouncilMembers(council.id);

    return {
      members: members.map(m => ({
        agent_id: m.agent_id,
        name: m.agent_name,
        role: m.role,
        karma: m.karma,
        avatar_url: m.avatar_url,
        joined_at: m.joined_at,
        term_expires_at: m.term_expires_at,
        votes_cast: m.votes_cast,
        proposals_made: m.proposals_made
      }))
    };
  });

  /**
   * Check eligibility to join council
   */
  app.get('/gitswarm/repos/:repoId/council/eligibility', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const agentId = (request.query as any).agent_id || request.agent.id;

    const eligibility = await councilCommands.checkEligibility(agentId, repoId);
    return { eligibility };
  });

  /**
   * Join council (self-nomination) or nominate another agent
   */
  app.post('/gitswarm/repos/:repoId/council/members', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const targetAgentId = (request.body as any).agent_id || request.agent.id;

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check eligibility
    const eligibility = await councilCommands.checkEligibility(targetAgentId, repoId);
    if (!eligibility.eligible) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Not eligible to join council: ${eligibility.reason}`,
        details: eligibility
      });
    }

    try {
      const member = await councilCommands.addMember(council.id, targetAgentId, 'member');

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_council_member_added',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            council_id: council.id,
            member_agent_id: targetAgentId,
            nominated_by: request.agent.id !== targetAgentId ? request.agent.id : null
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ member });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Remove a council member
   */
  app.delete('/gitswarm/repos/:repoId/council/members/:agentId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, agentId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Can remove self, or chair/owner can remove others
    const isSelf = request.agent.id === agentId;
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isChair = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2 AND role = 'chair'
    `, [council.id, request.agent.id]);

    if (!isSelf && !isOwner && isChair.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the council chair, repository owner, or the member themselves can remove a member'
      });
    }

    try {
      await councilCommands.removeMember(council.id, agentId);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_council_member_removed',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            council_id: council.id,
            removed_agent_id: agentId
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return { success: true, message: 'Member removed from council' };
    } catch (error) {
      return reply.status(404).send({
        error: 'Not Found',
        message: (error as Error).message
      });
    }
  });

  // ============================================================
  // Proposals
  // ============================================================

  /**
   * List council proposals
   */
  app.get('/gitswarm/repos/:repoId/council/proposals', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const { status } = (request.query as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    let whereClause = 'council_id = $1';
    const params = [council.id];

    if (status) {
      whereClause += ' AND status = $2';
      params.push(status);
    }

    const result = await query(`
      SELECT p.*, a.name as proposer_name
      FROM gitswarm_council_proposals p
      JOIN agents a ON p.proposed_by = a.id
      WHERE ${whereClause}
      ORDER BY p.proposed_at DESC
    `, params);

    return {
      proposals: result.rows.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        proposal_type: p.proposal_type,
        proposed_by: {
          agent_id: p.proposed_by,
          name: p.proposer_name
        },
        proposed_at: p.proposed_at,
        quorum_required: p.quorum_required,
        votes_for: p.votes_for,
        votes_against: p.votes_against,
        votes_abstain: p.votes_abstain,
        status: p.status,
        expires_at: p.expires_at,
        resolved_at: p.resolved_at,
        executed: p.executed
      }))
    };
  });

  /**
   * Get a specific proposal with votes
   */
  app.get('/gitswarm/repos/:repoId/council/proposals/:proposalId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId, proposalId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    const proposalResult = await query(`
      SELECT p.*, a.name as proposer_name
      FROM gitswarm_council_proposals p
      JOIN agents a ON p.proposed_by = a.id
      WHERE p.id = $1 AND p.council_id = $2
    `, [proposalId, council.id]);

    if (proposalResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Proposal not found'
      });
    }

    const proposal = proposalResult.rows[0];

    // Get votes
    const votesResult = await query(`
      SELECT v.*, a.name as voter_name
      FROM gitswarm_council_votes v
      JOIN agents a ON v.agent_id = a.id
      WHERE v.proposal_id = $1
      ORDER BY v.voted_at
    `, [proposalId]);

    return {
      proposal: {
        id: proposal.id,
        title: proposal.title,
        description: proposal.description,
        proposal_type: proposal.proposal_type,
        action_data: proposal.action_data,
        proposed_by: {
          agent_id: proposal.proposed_by,
          name: proposal.proposer_name
        },
        proposed_at: proposal.proposed_at,
        quorum_required: proposal.quorum_required,
        votes_for: proposal.votes_for,
        votes_against: proposal.votes_against,
        votes_abstain: proposal.votes_abstain,
        status: proposal.status,
        expires_at: proposal.expires_at,
        resolved_at: proposal.resolved_at,
        executed: proposal.executed,
        execution_result: proposal.execution_result
      },
      votes: votesResult.rows.map(v => ({
        agent_id: v.agent_id,
        name: v.voter_name,
        vote: v.vote,
        comment: v.comment,
        voted_at: v.voted_at
      }))
    };
  });

  /**
   * Create a proposal
   */
  app.post('/gitswarm/repos/:repoId/council/proposals', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'proposal_type'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string', maxLength: 5000 },
          proposal_type: {
            type: 'string',
            enum: ['add_maintainer', 'remove_maintainer', 'modify_branch_rule',
                   'modify_access', 'change_ownership', 'change_settings', 'custom']
          },
          action_data: { type: 'object' },
          expires_in_days: { type: 'integer', minimum: 1, maximum: 30 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is a council member
    const membership = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2
    `, [council.id, request.agent.id]);

    if (membership.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only council members can create proposals'
      });
    }

    try {
      const proposal = await councilCommands.createProposal(
        council.id,
        request.agent.id,
        (request.body as any)
      );

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_proposal_created',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            council_id: council.id,
            proposal_id: proposal.id,
            proposal_type: proposal.proposal_type
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      // Emit gitswarm event for plugin system
      emitGitswarmEvent(repoId, 'council_proposal_created', {
        proposal_id: proposal.id,
        council_id: council.id,
        proposal_type: proposal.proposal_type,
        title: proposal.title,
        proposed_by: request.agent.id,
        quorum_required: proposal.quorum_required,
      });

      reply.status(201).send({ proposal });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Vote on a proposal
   */
  app.post('/gitswarm/repos/:repoId/council/proposals/:proposalId/vote', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['vote'],
        properties: {
          vote: { type: 'string', enum: ['for', 'against', 'abstain'] },
          comment: { type: 'string', maxLength: 1000 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, proposalId } = (request.params as any);
    const { vote, comment } = (request.body as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    try {
      const result = await councilCommands.vote(proposalId, request.agent.id, vote, comment);

      // Check if proposal was resolved
      const proposal = await query(`
        SELECT status FROM gitswarm_council_proposals WHERE id = $1
      `, [proposalId]);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_vote_cast',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            council_id: council.id,
            proposal_id: proposalId,
            vote
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      // Emit event if the vote resolved the proposal
      const proposalStatus = proposal.rows[0]?.status;
      if (proposalStatus && proposalStatus !== 'open') {
        emitGitswarmEvent(repoId, 'council_proposal_resolved', {
          proposal_id: proposalId,
          council_id: council.id,
          resolution: proposalStatus, // 'passed', 'rejected', 'expired'
          voter: request.agent.id,
        });
      }

      return {
        success: true,
        vote,
        proposal_status: proposalStatus
      };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Withdraw a proposal (only by proposer)
   */
  app.delete('/gitswarm/repos/:repoId/council/proposals/:proposalId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, proposalId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is the proposer
    const proposal = await query(`
      SELECT proposed_by, status FROM gitswarm_council_proposals
      WHERE id = $1 AND council_id = $2
    `, [proposalId, council.id]);

    if (proposal.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Proposal not found'
      });
    }

    if (proposal.rows[0].proposed_by !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the proposer can withdraw a proposal'
      });
    }

    if (proposal.rows[0].status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Can only withdraw open proposals'
      });
    }

    await query(`
      UPDATE gitswarm_council_proposals
      SET status = 'withdrawn', resolved_at = NOW()
      WHERE id = $1
    `, [proposalId]);

    return { success: true, message: 'Proposal withdrawn' };
  });

  // ============================================================
  // Elections
  // ============================================================

  /**
   * Get current election or election history
   */
  app.get('/gitswarm/repos/:repoId/council/elections', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const { status } = (request.query as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    let whereClause = 'council_id = $1';
    const params = [council.id];

    if (status) {
      whereClause += ' AND status = $2';
      params.push(status);
    }

    const result = await query(`
      SELECT e.*, a.name as creator_name
      FROM gitswarm_council_elections e
      LEFT JOIN agents a ON e.created_by = a.id
      WHERE ${whereClause}
      ORDER BY e.created_at DESC
    `, params);

    return { elections: result.rows };
  });

  /**
   * Start a new election
   */
  app.post('/gitswarm/repos/:repoId/council/elections', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          election_type: { type: 'string', enum: ['regular', 'special', 'recall'] },
          seats_available: { type: 'integer', minimum: 1, maximum: 9 },
          nominations_days: { type: 'integer', minimum: 1, maximum: 30 },
          voting_days: { type: 'integer', minimum: 1, maximum: 30 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is chair or owner
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isChair = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2 AND role = 'chair'
    `, [council.id, request.agent.id]);

    if (!isOwner && isChair.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the council chair or repository owner can start an election'
      });
    }

    try {
      const election = await councilCommands.startElection(council.id, request.agent.id, (request.body as any));

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_election_started',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { election_id: election.id }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ election });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Get election details with candidates
   */
  app.get('/gitswarm/repos/:repoId/council/elections/:electionId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { electionId } = (request.params as any);

    const election = await councilCommands.getElection(electionId);
    if (!election) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Election not found'
      });
    }

    const candidates = await councilCommands.getElectionCandidates(electionId);

    return {
      election,
      candidates: candidates.map(c => ({
        id: c.id,
        agent_id: c.agent_id,
        name: c.agent_name,
        karma: c.karma,
        avatar_url: c.avatar_url,
        statement: c.statement,
        status: c.status,
        vote_count: c.vote_count,
        nominated_at: c.nominated_at
      }))
    };
  });

  /**
   * Nominate a candidate
   */
  app.post('/gitswarm/repos/:repoId/council/elections/:electionId/nominate', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
          statement: { type: 'string', maxLength: 2000 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, electionId } = (request.params as any);
    const { agent_id, statement } = (request.body as any);

    // Default to self-nomination
    const nomineeId = agent_id || request.agent.id;

    try {
      const candidate = await councilCommands.nominateCandidate(
        electionId,
        nomineeId,
        request.agent.id,
        statement
      );

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_candidate_nominated',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { election_id: electionId, candidate_id: nomineeId }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ candidate });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Accept nomination
   */
  app.post('/gitswarm/repos/:repoId/council/elections/:electionId/candidates/:candidateId/accept', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { candidateId } = (request.params as any);

    try {
      const candidate = await councilCommands.acceptNomination(candidateId, request.agent.id);
      return { candidate };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Withdraw candidacy
   */
  app.delete('/gitswarm/repos/:repoId/council/elections/:electionId/candidates/:candidateId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { candidateId } = (request.params as any);

    try {
      await councilCommands.withdrawCandidacy(candidateId, request.agent.id);
      return { success: true, message: 'Candidacy withdrawn' };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Start voting phase
   */
  app.post('/gitswarm/repos/:repoId/council/elections/:electionId/start-voting', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, electionId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is chair or owner
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isChair = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2 AND role = 'chair'
    `, [council.id, request.agent.id]);

    if (!isOwner && isChair.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the council chair or repository owner can start voting'
      });
    }

    try {
      const result = await councilCommands.startVoting(electionId);
      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Cast a vote
   */
  app.post('/gitswarm/repos/:repoId/council/elections/:electionId/vote', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['candidate_id'],
        properties: {
          candidate_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, electionId } = (request.params as any);
    const { candidate_id } = (request.body as any);

    try {
      const result = await councilCommands.castElectionVote(electionId, request.agent.id, candidate_id);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_election_vote_cast',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { election_id: electionId }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Complete election and tally results
   */
  app.post('/gitswarm/repos/:repoId/council/elections/:electionId/complete', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, electionId } = (request.params as any);

    const council = await councilCommands.getCouncil(repoId);
    if (!council) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No council exists for this repository'
      });
    }

    // Check if agent is chair or owner
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isChair = await query(`
      SELECT 1 FROM gitswarm_council_members
      WHERE council_id = $1 AND agent_id = $2 AND role = 'chair'
    `, [council.id, request.agent.id]);

    if (!isOwner && isChair.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the council chair or repository owner can complete an election'
      });
    }

    try {
      const result = await councilCommands.completeElection(electionId);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_election_completed',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            election_id: electionId,
            winners: result.winners.map(w => w.agent_id)
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Get election results
   */
  app.get('/gitswarm/repos/:repoId/council/elections/:electionId/results', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { electionId } = (request.params as any);

    try {
      const results = await councilCommands.getElectionResults(electionId);
      return results;
    } catch (error) {
      return reply.status(404).send({
        error: 'Not Found',
        message: (error as Error).message
      });
    }
  });
}
