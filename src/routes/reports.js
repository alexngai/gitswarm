/**
 * Content Reports Routes
 * Allows agents to report inappropriate content
 */

import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function reportRoutes(app) {
  const rateLimit = createRateLimiter('default');

  /**
   * POST /reports
   * Report content (post, comment, or agent)
   */
  app.post('/reports', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['target_type', 'target_id', 'reason'],
        properties: {
          target_type: { type: 'string', enum: ['post', 'comment', 'agent', 'knowledge', 'sync'] },
          target_id: { type: 'string', format: 'uuid' },
          reason: {
            type: 'string',
            enum: ['spam', 'harassment', 'misinformation', 'inappropriate', 'other'],
          },
          description: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const { target_type, target_id, reason, description } = request.body;

    // Verify target exists
    let targetExists = false;
    switch (target_type) {
      case 'post':
        targetExists = (await query('SELECT id FROM posts WHERE id = $1', [target_id])).rows.length > 0;
        break;
      case 'comment':
        targetExists = (await query('SELECT id FROM comments WHERE id = $1', [target_id])).rows.length > 0;
        break;
      case 'agent':
        targetExists = (await query('SELECT id FROM agents WHERE id = $1', [target_id])).rows.length > 0;
        break;
      case 'knowledge':
        targetExists = (await query('SELECT id FROM knowledge_nodes WHERE id = $1', [target_id])).rows.length > 0;
        break;
      case 'sync':
        targetExists = (await query('SELECT id FROM syncs WHERE id = $1', [target_id])).rows.length > 0;
        break;
    }

    if (!targetExists) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `${target_type} not found`,
      });
    }

    // Check for duplicate report
    const existing = await query(
      `SELECT id FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'pending'`,
      [request.agent.id, target_type, target_id]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You have already reported this content',
      });
    }

    const result = await query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, reporter_id, target_type, target_id, reason, description, status, created_at`,
      [request.agent.id, target_type, target_id, reason, description || null]
    );

    reply.status(201).send({ report: result.rows[0] });
  });

  /**
   * GET /reports/mine
   * Get reports submitted by current agent
   */
  app.get('/reports/mine', {
    preHandler: [authenticate, rateLimit],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'resolved', 'dismissed'] },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { status, limit = 20, offset = 0 } = request.query;

    let whereClause = 'reporter_id = $1';
    const params = [request.agent.id];

    if (status) {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT id, target_type, target_id, reason, description, status, created_at, resolved_at
       FROM reports
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { reports: result.rows };
  });
}

export default reportRoutes;
