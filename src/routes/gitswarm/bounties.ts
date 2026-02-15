import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { BountyService, bountyService as defaultBountyService } from '../../services/bounty.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

/**
 * GitSwarm Bounty Routes
 */
export async function bountyRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
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
    const { repoId } = (request.params as any);

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
    const { repoId } = (request.params as any);
    const { amount, description } = (request.body as any);

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
        message: (error as Error).message
      });
    }
  });

  /**
   * Get budget transaction history
   */
  app.get('/gitswarm/repos/:repoId/budget/transactions', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const { limit, offset } = (request.query as any);

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
    const { repoId } = (request.params as any);
    const { status, limit, offset } = (request.query as any);

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
    const { repoId } = (request.params as any);

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, repoId, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      const bounty = await bountyService.createBounty(repoId, (request.body as any), request.agent.id);

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
        message: (error as Error).message
      });
    }
  });

  /**
   * Get a specific bounty
   */
  app.get('/gitswarm/repos/:repoId/bounties/:bountyId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { bountyId } = (request.params as any);

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
    const { repoId, bountyId } = (request.params as any);
    const { reason } = (request.body as any) || {};

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
        message: (error as Error).message
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
    const { repoId, bountyId } = (request.params as any);

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
        message: (error as Error).message
      });
    }
  });

  /**
   * Submit work for a claim (supports stream_id linkage)
   */
  app.post('/gitswarm/repos/:repoId/bounties/:bountyId/claims/:claimId/submit', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          stream_id: { type: 'string' },
          notes: { type: 'string', maxLength: 2000 }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId, claimId } = (request.params as any);

    try {
      const claim = await bountyService.submitClaim(claimId, request.agent.id, (request.body as any));

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
        message: (error as Error).message
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
    const { repoId, claimId } = (request.params as any);
    const { decision, notes } = (request.body as any);

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
        message: (error as Error).message
      });
    }
  });

  /**
   * Abandon a claim
   */
  app.delete('/gitswarm/repos/:repoId/bounties/:bountyId/claims/:claimId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { claimId } = (request.params as any);

    try {
      await bountyService.abandonClaim(claimId, request.agent.id);
      return { success: true, message: 'Claim abandoned' };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: (error as Error).message
      });
    }
  });

  /**
   * Get agent's bounty claims
   */
  app.get('/gitswarm/me/claims', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { status } = (request.query as any);
    const claims = await bountyService.getAgentClaims(request.agent.id, status);
    return { claims };
  });

  // ============================================================
  // Task Routes (unified: task = bounty with optional budget)
  // ============================================================

  /**
   * List tasks for a repository
   */
  app.get('/gitswarm/repos/:repoId/tasks', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { repoId } = (request.params as any);
    const { status, limit, offset } = (request.query as any);
    const tasks = await bountyService.listTasks(repoId, {
      status,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    return { tasks };
  });

  /**
   * Create a task
   */
  app.post('/gitswarm/repos/:repoId/tasks', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 5000 },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          amount: { type: 'integer', minimum: 0 },
          labels: { type: 'array', items: { type: 'string' } },
          difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced', 'expert'] },
          expires_in_days: { type: 'integer', minimum: 1, maximum: 365 },
          github_issue_number: { type: 'integer' },
          github_issue_url: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const canWrite = await permissionService.canPerform(request.agent.id, repoId, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      const task = await bountyService.createTask(repoId, (request.body as any), request.agent.id);
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'task_created',
          target_type: 'task',
          target_id: task.id,
          metadata: { repo_id: repoId, title: task.title, amount: task.amount },
        }).catch(() => {});
      }
      return reply.status(201).send({ task });
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });

  /**
   * Get task details
   */
  app.get('/gitswarm/repos/:repoId/tasks/:taskId', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const task = await bountyService.getTask((request.params as any).taskId);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    const claims = await bountyService.listClaims((request.params as any).taskId);
    return { task, claims };
  });

  /**
   * Cancel a task
   */
  app.delete('/gitswarm/repos/:repoId/tasks/:taskId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId, taskId } = (request.params as any);
    const { reason } = (request.body as any) || {};

    const task = await bountyService.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'Task not found' });

    const isOwner = await permissionService.isOwner(request.agent.id, repoId);
    if (!isOwner && task.created_by !== request.agent.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      await bountyService.cancelTask(taskId, request.agent.id, reason);
      return { success: true };
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });

  /**
   * Claim a task (optionally with stream_id)
   */
  app.post('/gitswarm/repos/:repoId/tasks/:taskId/claim', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          stream_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { taskId } = (request.params as any);
    const { stream_id } = (request.body as any) || {};

    try {
      const claim = await bountyService.claimTask(taskId, request.agent.id, stream_id);
      return reply.status(201).send({ claim });
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });

  /**
   * Submit work on a task claim (with stream linkage)
   */
  app.post('/gitswarm/repos/:repoId/tasks/:taskId/claims/:claimId/submit', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          stream_id: { type: 'string' },
          notes: { type: 'string', maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const { claimId } = (request.params as any);
    try {
      const claim = await bountyService.submitClaim(claimId, request.agent.id, (request.body as any));
      return { claim };
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });

  /**
   * Review a task claim
   */
  app.post('/gitswarm/repos/:repoId/tasks/:taskId/claims/:claimId/review', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['decision'],
        properties: {
          decision: { type: 'string', enum: ['approve', 'reject'] },
          notes: { type: 'string', maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId, claimId } = (request.params as any);
    const { decision, notes } = (request.body as any);

    const isMaintainer = await permissionService.canPerform(request.agent.id, repoId, 'merge');
    if (!isMaintainer.allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      return await bountyService.reviewClaim(claimId, request.agent.id, decision, notes);
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });

  /**
   * Get claim linked to a stream
   */
  app.get('/gitswarm/streams/:streamId/claim', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const claim = await bountyService.getClaimByStream((request.params as any).streamId);
    return { claim };
  });

  /**
   * Link a claim to a stream
   */
  app.post('/gitswarm/claims/:claimId/link-stream', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['stream_id'],
        properties: {
          stream_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { claimId } = (request.params as any);
    const { stream_id } = (request.body as any);
    try {
      await bountyService.linkClaimToStream(claimId, stream_id);
      return { success: true };
    } catch (error) {
      return reply.status(400).send({ error: 'Bad Request', message: (error as Error).message });
    }
  });
}
