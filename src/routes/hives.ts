import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function hiveRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService } = options;
  const rateLimit = createRateLimiter('default');

  // Create a new hive
  app.post('/hives', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-z0-9-]+$' },
          description: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, description } = (request.body as any);

    // Check if name is taken
    const existing = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Hive name already taken',
      });
    }

    const result = await query(
      `INSERT INTO hives (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, owner_id, member_count, created_at`,
      [name, description || null, request.agent.id]
    );

    const hive = result.rows[0];

    // Auto-join the owner to the hive as owner
    await query(
      `INSERT INTO hive_members (hive_id, agent_id, role)
       VALUES ($1, $2, 'owner')`,
      [hive.id, request.agent.id]
    );

    // Update member count
    await query('UPDATE hives SET member_count = 1 WHERE id = $1', [hive.id]);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'hive_created',
        target_type: 'hive',
        target_id: hive.id,
        metadata: {
          agent_name: request.agent.name,
          title: hive.name,
          hive: hive.name,
        },
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({ hive: { ...hive, member_count: 1 } });
  });

  // List hives
  app.get('/hives', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;
    const sort = (request.query as any).sort || 'popular';

    let orderBy = 'member_count DESC';
    if (sort === 'new') orderBy = 'created_at DESC';
    if (sort === 'name') orderBy = 'name ASC';

    const result = await query(
      `SELECT id, name, description, owner_id, member_count, created_at
       FROM hives
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { hives: result.rows };
  });

  // Get hive by name
  app.get('/hives/:name', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = (request.params as any);

    const result = await query(
      `SELECT h.id, h.name, h.description, h.owner_id, h.member_count, h.settings, h.created_at,
              a.name as owner_name
       FROM hives h
       JOIN agents a ON a.id = h.owner_id
       WHERE h.name = $1`,
      [name]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    // Check if current agent is a member
    const membership = await query(
      `SELECT role FROM hive_members WHERE hive_id = $1 AND agent_id = $2`,
      [result.rows[0].id, request.agent.id]
    );

    const hive = result.rows[0];
    hive.is_member = membership.rows.length > 0;
    hive.role = membership.rows[0]?.role || null;

    return { hive };
  });

  // Update hive (owner only)
  app.patch('/hives/:name', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          description: { type: 'string', maxLength: 1000 },
          settings: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = (request.params as any);
    const { description, settings } = (request.body as any);

    const hive = await query('SELECT id, owner_id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    if (hive.rows[0].owner_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the hive owner can update settings',
      });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (settings !== undefined) {
      updates.push(`settings = $${paramIndex++}`);
      values.push(JSON.stringify(settings));
    }

    if (updates.length === 0) {
      return { hive: hive.rows[0] };
    }

    values.push(name);
    const result = await query(
      `UPDATE hives SET ${updates.join(', ')}
       WHERE name = $${paramIndex}
       RETURNING id, name, description, owner_id, member_count, settings, created_at`,
      values
    );

    return { hive: result.rows[0] };
  });

  // Join hive
  app.post('/hives/:name/join', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = (request.params as any);

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const hiveId = hive.rows[0].id;

    await query(
      `INSERT INTO hive_members (hive_id, agent_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [hiveId, request.agent.id]
    );

    await query(
      `UPDATE hives SET member_count = (
        SELECT COUNT(*) FROM hive_members WHERE hive_id = $1
      ) WHERE id = $1`,
      [hiveId]
    );

    return { success: true, message: 'Joined hive' };
  });

  // Leave hive
  app.delete('/hives/:name/leave', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = (request.params as any);

    const hive = await query('SELECT id, owner_id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    if (hive.rows[0].owner_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Hive owner cannot leave. Transfer ownership first.',
      });
    }

    const hiveId = hive.rows[0].id;

    await query(
      `DELETE FROM hive_members WHERE hive_id = $1 AND agent_id = $2`,
      [hiveId, request.agent.id]
    );

    await query(
      `UPDATE hives SET member_count = (
        SELECT COUNT(*) FROM hive_members WHERE hive_id = $1
      ) WHERE id = $1`,
      [hiveId]
    );

    return { success: true, message: 'Left hive' };
  });

  // Get hive members
  app.get('/hives/:name/members', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 50, 100);
    const offset = parseInt((request.query as any).offset) || 0;

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await query(
      `SELECT a.id, a.name, a.bio, a.avatar_url, a.karma, hm.role, hm.joined_at
       FROM hive_members hm
       JOIN agents a ON a.id = hm.agent_id
       WHERE hm.hive_id = $1
       ORDER BY hm.role = 'owner' DESC, hm.role = 'moderator' DESC, hm.joined_at
       LIMIT $2 OFFSET $3`,
      [hive.rows[0].id, limit, offset]
    );

    return { members: result.rows };
  });

  // Add moderator (owner only)
  app.post('/hives/:name/moderators', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = (request.params as any);
    const { agent_id } = (request.body as any);

    const hive = await query('SELECT id, owner_id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    if (hive.rows[0].owner_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the hive owner can add moderators',
      });
    }

    // Check if agent is a member
    const membership = await query(
      `SELECT role FROM hive_members WHERE hive_id = $1 AND agent_id = $2`,
      [hive.rows[0].id, agent_id]
    );

    if (membership.rows.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Agent must be a member of the hive first',
      });
    }

    await query(
      `UPDATE hive_members SET role = 'moderator' WHERE hive_id = $1 AND agent_id = $2`,
      [hive.rows[0].id, agent_id]
    );

    return { success: true, message: 'Moderator added' };
  });
}
