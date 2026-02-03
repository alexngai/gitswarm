import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { BountyService, bountyService as defaultBountyService } from '../../services/bounty.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

/**
 * GitSwarm Bounty Routes
 */
export async function bountyRoutes(app, options = {}) {
  const { activityService } = options;
  const bountyService = options.bountyService || defaultBountyService;
  const permissionService = new GitSwarmPermissionService();

  const rateLimit = createRateLimiter('default');
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  // ============================================================
  // Budget Routes
  // ============================================================

  /**
   * Get repository budget
   */
  app.get('/gitswarm/repos/:repoId/budget', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = request.params;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, repoId, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    const budget = await bountyService.getOrCreateBudget(repoId);
    const transactions = await bountyService.getBudgetTransactions(repoId, 10);

    return {
      budget: {
        total_credits: budget.total_credits,
        available_credits: budget.available_credits,
        reserved_credits: budget.reserved_credits,
        max_bounty_per_issue: budget.max_bounty_per_issue,
        min_bounty_amount: budget.min_bounty_amount
      },
      recent_transactions: transactions
    };
  });

  /**
   * Deposit credits to repository budget
   */
  app.post('/gitswarm/repos/:repoId/budget/deposit', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'integer', minimum: 1 },
          description: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = request.params;
    const { amount, description } = request.body;

    // Check if agent is owner or admin
    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const canAdmin = await permissionService.canPerform(request.agent.id, repoId, 'settings');

    if (!isOwner && !canAdmin.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository owners or admins can deposit credits'
      });
    }

    try {
      const result = await bountyService.depositCredits(repoId, amount, request.agent.id, description);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_budget_deposit',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { amount }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Get budget transaction history
   */
  app.get('/gitswarm/repos/:repoId/budget/transactions', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = request.params;
    const { limit, offset } = request.query;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, repoId, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    const transactions = await bountyService.getBudgetTransactions(
      repoId,
      parseInt(limit) || 50,
      parseInt(offset) || 0
    );

    return { transactions };
  });

  // ============================================================
  // Bounty Routes
  // ============================================================

  /**
   * List bounties for a repository
   */
  app.get('/gitswarm/repos/:repoId/bounties', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = request.params;
    const { status, limit, offset } = request.query;

    const bounties = await bountyService.listBounties(repoId, {
      status,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });

    return { bounties };
  });

  /**
   * Create a bounty
   */
  app.post('/gitswarm/repos/:repoId/bounties', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['github_issue_number', 'title', 'amount'],
        properties: {
          github_issue_number: { type: 'integer', minimum: 1 },
          github_issue_url: { type: 'string', maxLength: 500 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 5000 },
          amount: { type: 'integer', minimum: 1 },
          labels: { type: 'array', items: { type: 'string' } },
          difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced', 'expert'] },
          expires_in_days: { type: 'integer', minimum: 1, maximum: 365 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = request.params;

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, repoId, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      const bounty = await bountyService.createBounty(repoId, request.body, request.agent.id);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_bounty_created',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: {
            bounty_id: bounty.id,
            issue_number: bounty.github_issue_number,
            amount: bounty.amount
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ bounty });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Get a specific bounty
   */
  app.get('/gitswarm/repos/:repoId/bounties/:bountyId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { bountyId } = request.params;

    const bounty = await bountyService.getBounty(bountyId);

    if (!bounty) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found'
      });
    }

    const claims = await bountyService.listClaims(bountyId);

    return {
      bounty,
      claims
    };
  });

  /**
   * Cancel a bounty
   */
  app.delete('/gitswarm/repos/:repoId/bounties/:bountyId', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, bountyId } = request.params;
    const { reason } = request.body || {};

    // Check if agent is owner or bounty creator
    const bounty = await bountyService.getBounty(bountyId);
    if (!bounty) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found'
      });
    }

    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    const isCreator = bounty.created_by === request.agent.id;

    if (!isOwner && !isCreator) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the bounty creator or repository owner can cancel bounties'
      });
    }

    try {
      await bountyService.cancelBounty(bountyId, request.agent.id, reason);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_bounty_cancelled',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { bounty_id: bountyId, reason }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return { success: true, message: 'Bounty cancelled' };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  // ============================================================
  // Claim Routes
  // ============================================================

  /**
   * Claim a bounty
   */
  app.post('/gitswarm/repos/:repoId/bounties/:bountyId/claim', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, bountyId } = request.params;

    try {
      const claim = await bountyService.claimBounty(bountyId, request.agent.id);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_bounty_claimed',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { bounty_id: bountyId, claim_id: claim.id }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ claim });
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Submit work for a claim
   */
  app.post('/gitswarm/repos/:repoId/bounties/:bountyId/claims/:claimId/submit', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          patch_id: { type: 'string', format: 'uuid' },
          pr_url: { type: 'string', maxLength: 500 },
          notes: { type: 'string', maxLength: 2000 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, claimId } = request.params;

    try {
      const claim = await bountyService.submitClaim(claimId, request.agent.id, request.body);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_claim_submitted',
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { claim_id: claimId }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return { claim };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Review a claim (approve/reject)
   */
  app.post('/gitswarm/repos/:repoId/bounties/:bountyId/claims/:claimId/review', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['decision'],
        properties: {
          decision: { type: 'string', enum: ['approve', 'reject'] },
          notes: { type: 'string', maxLength: 2000 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, claimId } = request.params;
    const { decision, notes } = request.body;

    // Check if agent is maintainer or owner
    const isMaintainer = await permissionService.canPerform(request.agent.id, repoId, 'merge');
    if (!isMaintainer.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only maintainers can review bounty claims'
      });
    }

    try {
      const result = await bountyService.reviewClaim(claimId, request.agent.id, decision, notes);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: `gitswarm_claim_${decision}d`,
          target_type: 'gitswarm_repo',
          target_id: repoId,
          metadata: { claim_id: claimId }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Abandon a claim
   */
  app.delete('/gitswarm/repos/:repoId/bounties/:bountyId/claims/:claimId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { claimId } = request.params;

    try {
      await bountyService.abandonClaim(claimId, request.agent.id);
      return { success: true, message: 'Claim abandoned' };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Get agent's bounty claims
   */
  app.get('/gitswarm/me/claims', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { status } = request.query;
    const claims = await bountyService.getAgentClaims(request.agent.id, status);
    return { claims };
  });
}
