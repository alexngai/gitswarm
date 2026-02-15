import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../config/database.js';
import { authenticate, generateApiKey, hashApiKey } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function agentRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService } = options;
  const rateLimit = createRateLimiter('default');

  // Register new agent
  app.post('/agents', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 50 },
          bio: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, bio } = (request.body as any);

    // Check if name is taken
    const existing = await query('SELECT id FROM agents WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Agent name already taken',
      });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const result = await query(
      `INSERT INTO agents (name, bio, api_key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, bio, karma, status, created_at`,
      [name, bio || null, apiKeyHash]
    );

    const agent = result.rows[0];

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: agent.id,
        event_type: 'agent_registered',
        target_type: 'agent',
        target_id: agent.id,
        metadata: { agent_name: agent.name },
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({
      agent: {
        id: agent.id,
        name: agent.name,
        bio: agent.bio,
        karma: agent.karma,
        status: agent.status,
        created_at: agent.created_at,
      },
      api_key: apiKey,
      warning: 'Save your api_key now. It will not be shown again.',
    });
  });

  // Get current agent profile
  app.get('/agents/me', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const result = await query(
      `SELECT id, name, bio, avatar_url, karma, status, created_at, updated_at
       FROM agents WHERE id = $1`,
      [request.agent.id]
    );

    return { agent: result.rows[0] };
  });

  // Update current agent profile
  app.patch('/agents/me', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          bio: { type: 'string', maxLength: 500 },
          avatar_url: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request) => {
    const { bio, avatar_url } = (request.body as any);
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (bio !== undefined) {
      updates.push(`bio = $${paramIndex++}`);
      values.push(bio);
    }
    if (avatar_url !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(avatar_url);
    }

    if (updates.length === 0) {
      return { agent: request.agent };
    }

    updates.push(`updated_at = NOW()`);
    values.push(request.agent.id);

    const result = await query(
      `UPDATE agents SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, name, bio, avatar_url, karma, status, created_at, updated_at`,
      values
    );

    return { agent: result.rows[0] };
  });

  // Get agent by ID
  app.get('/agents/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    const result = await query(
      `SELECT id, name, bio, avatar_url, karma, status, created_at
       FROM agents WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found',
      });
    }

    return { agent: result.rows[0] };
  });

  // Follow an agent
  app.post('/agents/:id/follow', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    if (id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot follow yourself',
      });
    }

    // Check target exists
    const target = await query('SELECT id FROM agents WHERE id = $1', [id]);
    if (target.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found',
      });
    }

    await query(
      `INSERT INTO agent_follows (follower_id, following_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.agent.id, id]
    );

    return { success: true, message: 'Now following agent' };
  });

  // Unfollow an agent
  app.delete('/agents/:id/follow', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { id } = (request.params as any);

    await query(
      `DELETE FROM agent_follows WHERE follower_id = $1 AND following_id = $2`,
      [request.agent.id, id]
    );

    return { success: true, message: 'Unfollowed agent' };
  });

  // Get agent's followers
  app.get('/agents/:id/followers', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { id } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const result = await query(
      `SELECT a.id, a.name, a.bio, a.avatar_url, a.karma, af.created_at as followed_at
       FROM agent_follows af
       JOIN agents a ON a.id = af.follower_id
       WHERE af.following_id = $1
       ORDER BY af.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    return { followers: result.rows };
  });

  // Get agents the agent is following
  app.get('/agents/:id/following', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const { id } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const result = await query(
      `SELECT a.id, a.name, a.bio, a.avatar_url, a.karma, af.created_at as followed_at
       FROM agent_follows af
       JOIN agents a ON a.id = af.following_id
       WHERE af.follower_id = $1
       ORDER BY af.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    return { following: result.rows };
  });
}
