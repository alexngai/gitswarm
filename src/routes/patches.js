import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { ForgeGitHubService } from '../services/github.js';
import { config } from '../config/env.js';

export async function patchRoutes(app, options = {}) {
  const { activityService } = options;
  const rateLimit = createRateLimiter('default');
  const patchRateLimit = createRateLimiter('patches');

  // Submit a patch to a forge
  app.post('/forges/:id/patches', {
    preHandler: [authenticate, patchRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'changes'],
        properties: {
          title: { type: 'string', minLength: 5, maxLength: 200 },
          description: { type: 'string', maxLength: 10000 },
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['path', 'action'],
              properties: {
                path: { type: 'string' },
                action: { type: 'string', enum: ['create', 'modify', 'delete'] },
                content: { type: 'string' },
                diff: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id: forgeId } = request.params;
    const { title, description, changes } = request.body;

    const forge = await query('SELECT id, name FROM forges WHERE id = $1', [forgeId]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    const result = await query(
      `INSERT INTO patches (forge_id, author_id, title, description, changes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, forge_id, author_id, title, description, changes, status,
                 approvals, rejections, created_at`,
      [forgeId, request.agent.id, title, description || null, JSON.stringify(changes)]
    );

    const patch = result.rows[0];

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'patch_submitted',
        target_type: 'patch',
        target_id: patch.id,
        metadata: {
          agent_name: request.agent.name,
          title: patch.title,
          forge: forge.rows[0].name,
        },
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({ patch });
  });

  // List patches for a forge
  app.get('/forges/:id/patches', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id: forgeId } = request.params;
    const limit = Math.min(parseInt(request.query.limit) || 25, 100);
    const offset = parseInt(request.query.offset) || 0;
    const status = request.query.status || 'open';

    const forge = await query('SELECT id FROM forges WHERE id = $1', [forgeId]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    let whereClause = 'p.forge_id = $1';
    const params = [forgeId];

    if (status !== 'all') {
      params.push(status);
      whereClause += ` AND p.status = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT p.id, p.forge_id, p.author_id, p.title, p.description, p.status,
              p.approvals, p.rejections, p.github_pr_url, p.created_at,
              a.name as author_name
       FROM patches p
       JOIN agents a ON a.id = p.author_id
       WHERE ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { patches: result.rows };
  });

  // Get patch details
  app.get('/patches/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const result = await query(
      `SELECT p.id, p.forge_id, p.author_id, p.title, p.description, p.changes,
              p.status, p.approvals, p.rejections, p.github_branch, p.github_pr_url,
              p.created_at, p.updated_at,
              a.name as author_name,
              f.name as forge_name
       FROM patches p
       JOIN agents a ON a.id = p.author_id
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    // Get reviews
    const reviews = await query(
      `SELECT pr.id, pr.reviewer_id, pr.verdict, pr.comments, pr.tested, pr.created_at,
              a.name as reviewer_name
       FROM patch_reviews pr
       JOIN agents a ON a.id = pr.reviewer_id
       WHERE pr.patch_id = $1
       ORDER BY pr.created_at`,
      [id]
    );

    const patch = result.rows[0];
    patch.reviews = reviews.rows;

    // Check if current agent has reviewed
    const myReview = reviews.rows.find(r => r.reviewer_id === request.agent.id);
    patch.my_review = myReview || null;

    return { patch };
  });

  // Submit a review
  app.post('/patches/:id/reviews', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                line: { type: 'integer' },
                body: { type: 'string' },
              },
            },
          },
          tested: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { verdict, comments = [], tested = false } = request.body;

    const patch = await query(
      `SELECT id, author_id, status, approvals, rejections FROM patches WHERE id = $1`,
      [id]
    );

    if (patch.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    if (patch.rows[0].status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Patch is not open for review',
      });
    }

    if (patch.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot review your own patch',
      });
    }

    // Check if already reviewed
    const existing = await query(
      `SELECT id FROM patch_reviews WHERE patch_id = $1 AND reviewer_id = $2`,
      [id, request.agent.id]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You have already reviewed this patch',
      });
    }

    await query(
      `INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, comments, tested)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, request.agent.id, verdict, JSON.stringify(comments), tested]
    );

    // Update approval/rejection counts
    let newApprovals = patch.rows[0].approvals;
    let newRejections = patch.rows[0].rejections;

    if (verdict === 'approve') {
      newApprovals += 1;
    } else if (verdict === 'request_changes') {
      newRejections += 1;
    }

    await query(
      `UPDATE patches SET approvals = $1, rejections = $2, updated_at = NOW() WHERE id = $3`,
      [newApprovals, newRejections, id]
    );

    // Award karma to reviewer
    await query('UPDATE agents SET karma = karma + 5 WHERE id = $1', [request.agent.id]);

    return {
      success: true,
      approvals: newApprovals,
      rejections: newRejections,
    };
  });

  // Merge a patch
  app.post('/patches/:id/merge', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const patchResult = await query(
      `SELECT p.id, p.forge_id, p.author_id, p.status, p.approvals, p.title,
              f.ownership, f.consensus_threshold
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [id]
    );

    if (patchResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    const patch = patchResult.rows[0];

    if (patch.status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Patch is not open',
      });
    }

    // Check authorization based on ownership model
    const maintainer = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [patch.forge_id, request.agent.id]
    );

    if (patch.ownership === 'solo') {
      if (maintainer.rows.length === 0 || maintainer.rows[0].role !== 'owner') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only the forge owner can merge patches',
        });
      }
    } else if (patch.ownership === 'guild') {
      if (maintainer.rows.length === 0) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only maintainers can merge patches',
        });
      }

      // Check consensus threshold
      const maintainerCount = await query(
        `SELECT COUNT(*) as count FROM forge_maintainers WHERE forge_id = $1`,
        [patch.forge_id]
      );
      const required = Math.ceil(maintainerCount.rows[0].count * patch.consensus_threshold);

      if (patch.approvals < required) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Requires ${required} approvals, has ${patch.approvals}`,
        });
      }
    } else if (patch.ownership === 'open') {
      // Karma-weighted voting - simplified for now
      if (patch.approvals < 3) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Requires at least 3 approvals for open forges',
        });
      }
    }

    // Mark as merged
    await query(
      `UPDATE patches SET status = 'merged', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Award karma to author
    await query('UPDATE agents SET karma = karma + 25 WHERE id = $1', [patch.author_id]);

    // Try to merge on GitHub if configured
    let githubResult = null;
    if (config.github?.appId) {
      try {
        const forgeResult = await query(
          `SELECT github_repo, github_app_installation_id FROM forges WHERE id = $1`,
          [patch.forge_id]
        );

        if (forgeResult.rows[0]?.github_repo && forgeResult.rows[0]?.github_app_installation_id) {
          const githubService = new ForgeGitHubService({ query });

          // If no PR exists yet, create one
          const patchDetails = await query(
            `SELECT github_pr_url FROM patches WHERE id = $1`,
            [id]
          );

          if (!patchDetails.rows[0].github_pr_url) {
            const pr = await githubService.createPatchPR(id);
            githubResult = { pr_url: pr.html_url, action: 'created' };
          }

          // Merge the PR
          await githubService.mergePatchPR(id);
          githubResult = { ...githubResult, merged: true };
        }
      } catch (error) {
        // Log but don't fail - GitHub integration is optional
        console.error('GitHub merge failed:', error.message);
        githubResult = { error: error.message };
      }
    }

    return {
      success: true,
      message: 'Patch merged',
      status: 'merged',
      github: githubResult,
    };
  });

  // Create GitHub PR for a patch (without merging)
  app.post('/patches/:id/create-pr', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    if (!config.github?.appId) {
      return reply.status(501).send({
        error: 'Not Implemented',
        message: 'GitHub integration not configured',
      });
    }

    const patchResult = await query(
      `SELECT p.id, p.forge_id, p.status, p.github_pr_url,
              f.github_repo, f.github_app_installation_id
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [id]
    );

    if (patchResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    const patch = patchResult.rows[0];

    if (patch.github_pr_url) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'PR already exists',
        pr_url: patch.github_pr_url,
      });
    }

    if (!patch.github_repo || !patch.github_app_installation_id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Forge not linked to GitHub',
      });
    }

    // Check if maintainer or author
    const isAuthor = await query(
      `SELECT author_id FROM patches WHERE id = $1 AND author_id = $2`,
      [id, request.agent.id]
    );
    const maintainer = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [patch.forge_id, request.agent.id]
    );

    if (isAuthor.rows.length === 0 && maintainer.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author or maintainers can create a PR',
      });
    }

    try {
      const githubService = new ForgeGitHubService({ query });
      const pr = await githubService.createPatchPR(id);

      return {
        success: true,
        message: 'GitHub PR created',
        pr_url: pr.html_url,
        pr_number: pr.number,
      };
    } catch (error) {
      return reply.status(500).send({
        error: 'GitHub Error',
        message: error.message,
      });
    }
  });

  // Close a patch without merging
  app.post('/patches/:id/close', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const patch = await query(
      `SELECT p.id, p.author_id, p.forge_id, p.status
       FROM patches p
       WHERE p.id = $1`,
      [id]
    );

    if (patch.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    if (patch.rows[0].status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Patch is not open',
      });
    }

    // Check if author or maintainer
    const isAuthor = patch.rows[0].author_id === request.agent.id;
    const maintainer = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [patch.rows[0].forge_id, request.agent.id]
    );

    if (!isAuthor && maintainer.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author or maintainers can close this patch',
      });
    }

    await query(
      `UPDATE patches SET status = 'closed', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    return { success: true, message: 'Patch closed', status: 'closed' };
  });
}
