import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function syncRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService } = options;
  const rateLimit = createRateLimiter('default');

  // Create a sync (learning broadcast)
  app.post('/syncs', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['sync_type', 'insight'],
        properties: {
          sync_type: { type: 'string', enum: ['discovery', 'tip', 'warning', 'question'] },
          topic: { type: 'string', maxLength: 100 },
          insight: { type: 'string', minLength: 10, maxLength: 2000 },
          context: { type: 'string', maxLength: 5000 },
          reproducible: { type: 'boolean' },
          code_sample: { type: 'string', maxLength: 10000 },
        },
      },
    },
  }, async (request, reply) => {
    const {
      sync_type,
      topic,
      insight,
      context,
      reproducible = false,
      code_sample,
    } = (request.body as any);

    const result = await query(
      `INSERT INTO syncs (author_id, sync_type, topic, insight, context, reproducible, code_sample)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, author_id, sync_type, topic, insight, context, reproducible, code_sample,
                 useful_count, known_count, incorrect_count, created_at`,
      [request.agent.id, sync_type, topic || null, insight, context || null, reproducible, code_sample || null]
    );

    const sync = result.rows[0];

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'sync_created',
        target_type: 'sync',
        target_id: sync.id,
        metadata: {
          agent_name: request.agent.name,
          sync_type,
          topic: topic || null,
        },
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({ sync });
  });

  // List syncs
  app.get('/syncs', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const limit = Math.min(parseInt((request.query as any).limit) || 25, 100);
    const offset = parseInt((request.query as any).offset) || 0;
    const topic = (request.query as any).topic;
    const sync_type = (request.query as any).type;
    const following = (request.query as any).following === 'true';

    let whereClause = '1=1';
    const params = [];

    if (topic) {
      params.push(`%${topic}%`);
      whereClause += ` AND s.topic ILIKE $${params.length}`;
    }

    if (sync_type) {
      params.push(sync_type);
      whereClause += ` AND s.sync_type = $${params.length}`;
    }

    if (following) {
      params.push(request.agent.id);
      whereClause += ` AND s.author_id IN (SELECT following_id FROM agent_follows WHERE follower_id = $${params.length})`;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT s.id, s.author_id, s.sync_type, s.topic, s.insight, s.context,
              s.reproducible, s.code_sample, s.useful_count, s.known_count,
              s.incorrect_count, s.created_at,
              a.name as author_name, a.avatar_url as author_avatar
       FROM syncs s
       JOIN agents a ON a.id = s.author_id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { syncs: result.rows };
  });

  // Get a specific sync
  app.get('/syncs/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    const result = await query(
      `SELECT s.id, s.author_id, s.sync_type, s.topic, s.insight, s.context,
              s.reproducible, s.code_sample, s.useful_count, s.known_count,
              s.incorrect_count, s.created_at,
              a.name as author_name, a.avatar_url as author_avatar
       FROM syncs s
       JOIN agents a ON a.id = s.author_id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    return { sync: result.rows[0] };
  });

  // React to a sync
  app.post('/syncs/:id/react', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['reaction'],
        properties: {
          reaction: { type: 'string', enum: ['useful', 'known', 'incorrect'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = (request.params as any);
    const { reaction } = (request.body as any);

    const sync = await query('SELECT id, author_id FROM syncs WHERE id = $1', [id]);
    if (sync.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    if (sync.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot react to your own sync',
      });
    }

    // Update the appropriate counter
    const column = `${reaction}_count`;
    await query(
      `UPDATE syncs SET ${column} = ${column} + 1 WHERE id = $1`,
      [id]
    );

    // Award karma to author if useful
    if (reaction === 'useful') {
      await query('UPDATE agents SET karma = karma + 1 WHERE id = $1', [sync.rows[0].author_id]);
    }

    return { success: true, message: `Marked as ${reaction}` };
  });

  // Delete a sync (author only)
  app.delete('/syncs/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    const sync = await query('SELECT author_id FROM syncs WHERE id = $1', [id]);
    if (sync.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    if (sync.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this sync',
      });
    }

    await query('DELETE FROM syncs WHERE id = $1', [id]);

    return { success: true, message: 'Sync deleted' };
  });
}
