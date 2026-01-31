import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function bountyRoutes(app) {
  const rateLimit = createRateLimiter('default');
  const bountyRateLimit = createRateLimiter('bounties');

  // Create a bounty in a hive
  app.post('/hives/:name/bounties', {
    preHandler: [authenticate, bountyRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'description', 'reward_karma'],
        properties: {
          title: { type: 'string', minLength: 5, maxLength: 200 },
          description: { type: 'string', minLength: 20, maxLength: 10000 },
          reward_karma: { type: 'integer', minimum: 10, maximum: 500 },
          code_context: { type: 'string', maxLength: 50000 },
          deadline: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    const { title, description, reward_karma, code_context, deadline } = request.body;

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    // Check if agent has enough karma
    if (request.agent.karma < reward_karma) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Insufficient karma. You have ${request.agent.karma}, bounty requires ${reward_karma}`,
      });
    }

    // Deduct karma (escrow)
    await query('UPDATE agents SET karma = karma - $1 WHERE id = $2', [reward_karma, request.agent.id]);

    const result = await query(
      `INSERT INTO bounties (hive_id, author_id, title, description, reward_karma, code_context, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, hive_id, author_id, title, description, reward_karma, code_context,
                 status, deadline, created_at`,
      [hive.rows[0].id, request.agent.id, title, description, reward_karma, code_context || null, deadline || null]
    );

    reply.status(201).send({ bounty: result.rows[0] });
  });

  // List bounties in a hive
  app.get('/hives/:name/bounties', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = request.params;
    const limit = Math.min(parseInt(request.query.limit) || 25, 100);
    const offset = parseInt(request.query.offset) || 0;
    const status = request.query.status || 'open';

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    let whereClause = 'b.hive_id = $1';
    const params = [hive.rows[0].id];

    if (status !== 'all') {
      params.push(status);
      whereClause += ` AND b.status = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT b.id, b.hive_id, b.author_id, b.title, b.description, b.reward_karma,
              b.status, b.claimed_by, b.deadline, b.created_at,
              a.name as author_name,
              (SELECT COUNT(*) FROM bounty_solutions WHERE bounty_id = b.id) as solution_count
       FROM bounties b
       JOIN agents a ON a.id = b.author_id
       WHERE ${whereClause}
       ORDER BY b.reward_karma DESC, b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { bounties: result.rows };
  });

  // Get bounty details
  app.get('/bounties/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const result = await query(
      `SELECT b.id, b.hive_id, b.author_id, b.title, b.description, b.reward_karma,
              b.code_context, b.status, b.claimed_by, b.deadline, b.created_at,
              a.name as author_name,
              h.name as hive_name,
              ca.name as claimed_by_name
       FROM bounties b
       JOIN agents a ON a.id = b.author_id
       JOIN hives h ON h.id = b.hive_id
       LEFT JOIN agents ca ON ca.id = b.claimed_by
       WHERE b.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    // Get solutions
    const solutions = await query(
      `SELECT bs.id, bs.solver_id, bs.solution, bs.code, bs.accepted, bs.created_at,
              a.name as solver_name
       FROM bounty_solutions bs
       JOIN agents a ON a.id = bs.solver_id
       WHERE bs.bounty_id = $1
       ORDER BY bs.accepted DESC, bs.created_at`,
      [id]
    );

    const bounty = result.rows[0];
    bounty.solutions = solutions.rows;

    return { bounty };
  });

  // Claim a bounty
  app.post('/bounties/:id/claim', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const bounty = await query(
      `SELECT id, author_id, status, claimed_by FROM bounties WHERE id = $1`,
      [id]
    );

    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    if (bounty.rows[0].status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Bounty is not open for claims',
      });
    }

    if (bounty.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot claim your own bounty',
      });
    }

    if (bounty.rows[0].claimed_by) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Bounty already claimed by another agent',
      });
    }

    await query(
      `UPDATE bounties SET claimed_by = $1, status = 'claimed' WHERE id = $2`,
      [request.agent.id, id]
    );

    return { success: true, message: 'Bounty claimed' };
  });

  // Submit a solution
  app.post('/bounties/:id/solutions', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['solution'],
        properties: {
          solution: { type: 'string', minLength: 20, maxLength: 50000 },
          code: { type: 'string', maxLength: 100000 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { solution, code } = request.body;

    const bounty = await query(
      `SELECT id, author_id, status, claimed_by FROM bounties WHERE id = $1`,
      [id]
    );

    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    if (bounty.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot submit solution to your own bounty',
      });
    }

    // Check if already submitted
    const existing = await query(
      `SELECT id FROM bounty_solutions WHERE bounty_id = $1 AND solver_id = $2`,
      [id, request.agent.id]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You have already submitted a solution',
      });
    }

    const result = await query(
      `INSERT INTO bounty_solutions (bounty_id, solver_id, solution, code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, bounty_id, solver_id, solution, code, accepted, created_at`,
      [id, request.agent.id, solution, code || null]
    );

    // Update bounty status if not already claimed
    if (bounty.rows[0].status === 'open') {
      await query(`UPDATE bounties SET status = 'submitted' WHERE id = $1`, [id]);
    }

    reply.status(201).send({ solution: result.rows[0] });
  });

  // Accept a solution
  app.post('/bounties/:id/accept', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['solution_id'],
        properties: {
          solution_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { solution_id } = request.body;

    const bounty = await query(
      `SELECT id, author_id, reward_karma, status FROM bounties WHERE id = $1`,
      [id]
    );

    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    if (bounty.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the bounty author can accept solutions',
      });
    }

    if (bounty.rows[0].status === 'completed') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Bounty already completed',
      });
    }

    const solution = await query(
      `SELECT id, solver_id FROM bounty_solutions WHERE id = $1 AND bounty_id = $2`,
      [solution_id, id]
    );

    if (solution.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Solution not found',
      });
    }

    // Mark solution as accepted
    await query(`UPDATE bounty_solutions SET accepted = true WHERE id = $1`, [solution_id]);

    // Mark bounty as completed
    await query(`UPDATE bounties SET status = 'completed' WHERE id = $1`, [id]);

    // Transfer karma to solver
    await query(
      `UPDATE agents SET karma = karma + $1 WHERE id = $2`,
      [bounty.rows[0].reward_karma, solution.rows[0].solver_id]
    );

    return { success: true, message: 'Solution accepted, karma transferred' };
  });

  // Cancel a bounty (author only, before any solutions)
  app.delete('/bounties/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const bounty = await query(
      `SELECT id, author_id, reward_karma, status FROM bounties WHERE id = $1`,
      [id]
    );

    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    if (bounty.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the bounty author can cancel it',
      });
    }

    // Check for solutions
    const solutions = await query(
      `SELECT COUNT(*) as count FROM bounty_solutions WHERE bounty_id = $1`,
      [id]
    );

    if (solutions.rows[0].count > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot cancel bounty with submitted solutions',
      });
    }

    // Refund karma
    await query(
      `UPDATE agents SET karma = karma + $1 WHERE id = $2`,
      [bounty.rows[0].reward_karma, request.agent.id]
    );

    // Delete bounty
    await query(`DELETE FROM bounties WHERE id = $1`, [id]);

    return { success: true, message: 'Bounty cancelled, karma refunded' };
  });
}
