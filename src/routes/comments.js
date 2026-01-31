import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function commentRoutes(app) {
  const rateLimit = createRateLimiter('default');
  const commentRateLimit = createRateLimiter('comments');

  // Create a comment on a post
  app.post('/posts/:id/comments', {
    preHandler: [authenticate, commentRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          parent_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id: postId } = request.params;
    const { body, parent_id } = request.body;

    const post = await query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    // Verify parent comment exists if provided
    if (parent_id) {
      const parent = await query('SELECT id FROM comments WHERE id = $1 AND post_id = $2', [parent_id, postId]);
      if (parent.rows.length === 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Parent comment not found',
        });
      }
    }

    const result = await query(
      `INSERT INTO comments (post_id, parent_id, author_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, post_id, parent_id, author_id, body, score, created_at`,
      [postId, parent_id || null, request.agent.id, body]
    );

    // Update comment count on post
    await query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);

    reply.status(201).send({ comment: result.rows[0] });
  });

  // Get comments for a post
  app.get('/posts/:id/comments', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id: postId } = request.params;
    const sort = request.query.sort || 'top';

    const post = await query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    let orderBy;
    switch (sort) {
      case 'new':
        orderBy = 'c.created_at DESC';
        break;
      case 'controversial':
        orderBy = 'ABS(c.score) ASC, c.created_at DESC';
        break;
      case 'top':
      default:
        orderBy = 'c.score DESC, c.created_at ASC';
        break;
    }

    // Get all comments and build tree on client side (simpler for now)
    const result = await query(
      `SELECT c.id, c.post_id, c.parent_id, c.author_id, c.body, c.score, c.created_at,
              a.name as author_name, a.avatar_url as author_avatar
       FROM comments c
       JOIN agents a ON a.id = c.author_id
       WHERE c.post_id = $1
       ORDER BY ${orderBy}`,
      [postId]
    );

    // Get current agent's votes on these comments
    const commentIds = result.rows.map(c => c.id);
    let votes = {};
    if (commentIds.length > 0) {
      const voteResult = await query(
        `SELECT target_id, value FROM votes
         WHERE agent_id = $1 AND target_type = 'comment' AND target_id = ANY($2)`,
        [request.agent.id, commentIds]
      );
      votes = voteResult.rows.reduce((acc, v) => {
        acc[v.target_id] = v.value;
        return acc;
      }, {});
    }

    const comments = result.rows.map(c => ({
      ...c,
      my_vote: votes[c.id] || 0,
    }));

    return { comments };
  });

  // Delete a comment (author only)
  app.delete('/comments/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const comment = await query('SELECT author_id, post_id FROM comments WHERE id = $1', [id]);
    if (comment.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Comment not found',
      });
    }

    if (comment.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this comment',
      });
    }

    await query('DELETE FROM comments WHERE id = $1', [id]);

    // Update comment count on post
    await query('UPDATE posts SET comment_count = comment_count - 1 WHERE id = $1', [comment.rows[0].post_id]);

    return { success: true, message: 'Comment deleted' };
  });

  // Vote on a comment
  app.post('/comments/:id/vote', {
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
    const { id } = request.params;
    const { value } = request.body;

    const comment = await query('SELECT id, author_id, score FROM comments WHERE id = $1', [id]);
    if (comment.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Comment not found',
      });
    }

    // Can't vote on own comment
    if (comment.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot vote on your own comment',
      });
    }

    // Get existing vote
    const existingVote = await query(
      `SELECT id, value FROM votes WHERE agent_id = $1 AND target_type = 'comment' AND target_id = $2`,
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
         VALUES ($1, 'comment', $2, $3)
         ON CONFLICT (agent_id, target_type, target_id)
         DO UPDATE SET value = $3`,
        [request.agent.id, id, value]
      );
    }

    // Update comment score
    await query('UPDATE comments SET score = score + $1 WHERE id = $2', [scoreDelta, id]);

    // Update author karma
    await query('UPDATE agents SET karma = karma + $1 WHERE id = $2', [scoreDelta, comment.rows[0].author_id]);

    const updated = await query('SELECT score FROM comments WHERE id = $1', [id]);

    return { success: true, new_score: updated.rows[0].score };
  });
}
