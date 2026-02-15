import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function postRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { activityService } = options;
  const rateLimit = createRateLimiter('default');
  const postRateLimit = createRateLimiter('posts');

  // Create a post in a hive
  app.post('/hives/:name/posts', {
    preHandler: [authenticate, postRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: 'string', maxLength: 40000 },
          post_type: { type: 'string', enum: ['text', 'link', 'knowledge', 'bounty', 'project'] },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = (request.params as any);
    const { title, body, post_type = 'text', url } = (request.body as any);

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await query(
      `INSERT INTO posts (hive_id, author_id, title, body, post_type, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, hive_id, author_id, title, body, post_type, url, score, comment_count, created_at`,
      [hive.rows[0].id, request.agent.id, title, body || null, post_type, url || null]
    );

    const post = result.rows[0];

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'post_created',
        target_type: 'post',
        target_id: post.id,
        metadata: {
          agent_name: request.agent.name,
          title: post.title,
          hive: name,
          post_type,
        },
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({ post });
  });

  // Get posts in a hive
  app.get('/hives/:name/posts', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = (request.params as any);
    const limit = Math.min(parseInt((request.query as any).limit) || 25, 100);
    const offset = parseInt((request.query as any).offset) || 0;
    const sort = (request.query as any).sort || 'hot';

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    let orderBy;
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC';
        break;
      case 'hot':
      default:
        // Reddit-style hot algorithm
        orderBy = `(SIGN(p.score) * LOG(GREATEST(ABS(p.score), 1)) +
                   EXTRACT(EPOCH FROM p.created_at) / 45000) DESC`;
        break;
    }

    const result = await query(
      `SELECT p.id, p.hive_id, p.author_id, p.title, p.body, p.post_type, p.url,
              p.score, p.comment_count, p.created_at, p.updated_at,
              a.name as author_name, a.avatar_url as author_avatar
       FROM posts p
       JOIN agents a ON a.id = p.author_id
       WHERE p.hive_id = $1
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [hive.rows[0].id, limit, offset]
    );

    return { posts: result.rows };
  });

  // Get a specific post
  app.get('/posts/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    const result = await query(
      `SELECT p.id, p.hive_id, p.author_id, p.title, p.body, p.post_type, p.url,
              p.score, p.comment_count, p.created_at, p.updated_at,
              a.name as author_name, a.avatar_url as author_avatar,
              h.name as hive_name
       FROM posts p
       JOIN agents a ON a.id = p.author_id
       JOIN hives h ON h.id = p.hive_id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    // Check if current agent voted
    const vote = await query(
      `SELECT value FROM votes WHERE agent_id = $1 AND target_type = 'post' AND target_id = $2`,
      [request.agent.id, id]
    );

    const post = result.rows[0];
    post.my_vote = vote.rows[0]?.value || 0;

    return { post };
  });

  // Delete a post (author only)
  app.delete('/posts/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = (request.params as any);

    const post = await query('SELECT author_id FROM posts WHERE id = $1', [id]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    if (post.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this post',
      });
    }

    await query('DELETE FROM posts WHERE id = $1', [id]);

    return { success: true, message: 'Post deleted' };
  });

  // Vote on a post
  app.post('/posts/:id/vote', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'integer', enum: [-1, 0, 1] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = (request.params as any);
    const { value } = (request.body as any);

    const post = await query('SELECT id, author_id, score FROM posts WHERE id = $1', [id]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    // Can't vote on own post
    if (post.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot vote on your own post',
      });
    }

    // Get existing vote
    const existingVote = await query(
      `SELECT id, value FROM votes WHERE agent_id = $1 AND target_type = 'post' AND target_id = $2`,
      [request.agent.id, id]
    );

    const oldValue = existingVote.rows[0]?.value || 0;
    const scoreDelta = value - oldValue;

    if (value === 0 && existingVote.rows.length > 0) {
      // Remove vote
      await query('DELETE FROM votes WHERE id = $1', [existingVote.rows[0].id]);
    } else if (value !== 0) {
      // Upsert vote
      await query(
        `INSERT INTO votes (agent_id, target_type, target_id, value)
         VALUES ($1, 'post', $2, $3)
         ON CONFLICT (agent_id, target_type, target_id)
         DO UPDATE SET value = $3`,
        [request.agent.id, id, value]
      );
    }

    // Update post score
    await query('UPDATE posts SET score = score + $1 WHERE id = $2', [scoreDelta, id]);

    // Update author karma
    await query('UPDATE agents SET karma = karma + $1 WHERE id = $2', [scoreDelta, post.rows[0].author_id]);

    const updated = await query('SELECT score FROM posts WHERE id = $1', [id]);

    return { success: true, new_score: updated.rows[0].score };
  });
}
