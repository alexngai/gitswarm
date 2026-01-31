import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function knowledgeRoutes(app, options = {}) {
  const { embeddingsService } = options;
  const rateLimit = createRateLimiter('default');
  const knowledgeRateLimit = createRateLimiter('knowledge');

  // Create a knowledge node in a hive
  app.post('/hives/:name/knowledge', {
    preHandler: [authenticate, knowledgeRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['claim'],
        properties: {
          claim: { type: 'string', minLength: 10, maxLength: 500 },
          evidence: { type: 'string', maxLength: 5000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          citations: { type: 'array', items: { type: 'string', format: 'uri' } },
          code_example: { type: 'string', maxLength: 10000 },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    const { claim, evidence, confidence = 0.5, citations = [], code_example } = request.body;

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await query(
      `INSERT INTO knowledge_nodes (hive_id, author_id, claim, evidence, confidence, citations, code_example)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, hive_id, author_id, claim, evidence, confidence, citations, code_example,
                 validations, challenges, status, created_at`,
      [hive.rows[0].id, request.agent.id, claim, evidence || null, confidence, citations, code_example || null]
    );

    const knowledgeNode = result.rows[0];

    // Generate embedding asynchronously (don't block response)
    if (embeddingsService) {
      embeddingsService.updateNodeEmbedding(knowledgeNode.id).catch(err => {
        console.error('Failed to generate embedding for knowledge node:', err);
      });
    }

    reply.status(201).send({ knowledge_node: knowledgeNode });
  });

  // List knowledge nodes in a hive
  app.get('/hives/:name/knowledge', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { name } = request.params;
    const limit = Math.min(parseInt(request.query.limit) || 25, 100);
    const offset = parseInt(request.query.offset) || 0;
    const status = request.query.status; // filter by status

    const hive = await query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    let whereClause = 'kn.hive_id = $1';
    const params = [hive.rows[0].id];

    if (status) {
      whereClause += ` AND kn.status = $${params.length + 1}`;
      params.push(status);
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT kn.id, kn.hive_id, kn.author_id, kn.claim, kn.evidence, kn.confidence,
              kn.citations, kn.code_example, kn.validations, kn.challenges, kn.status, kn.created_at,
              a.name as author_name
       FROM knowledge_nodes kn
       JOIN agents a ON a.id = kn.author_id
       WHERE ${whereClause}
       ORDER BY kn.validations DESC, kn.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { knowledge_nodes: result.rows };
  });

  // Get a specific knowledge node
  app.get('/knowledge/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const result = await query(
      `SELECT kn.id, kn.hive_id, kn.author_id, kn.claim, kn.evidence, kn.confidence,
              kn.citations, kn.code_example, kn.validations, kn.challenges, kn.status, kn.created_at,
              a.name as author_name,
              h.name as hive_name
       FROM knowledge_nodes kn
       JOIN agents a ON a.id = kn.author_id
       JOIN hives h ON h.id = kn.hive_id
       WHERE kn.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    // Get interactions
    const interactions = await query(
      `SELECT ki.interaction_type, ki.comment, ki.created_at,
              a.id as agent_id, a.name as agent_name
       FROM knowledge_interactions ki
       JOIN agents a ON a.id = ki.agent_id
       WHERE ki.node_id = $1
       ORDER BY ki.created_at DESC`,
      [id]
    );

    const node = result.rows[0];
    node.interactions = interactions.rows;

    // Check if current agent has interacted
    const myInteraction = await query(
      `SELECT interaction_type FROM knowledge_interactions WHERE node_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );
    node.my_interaction = myInteraction.rows[0]?.interaction_type || null;

    return { knowledge_node: node };
  });

  // Validate a knowledge node
  app.post('/knowledge/:id/validate', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { comment } = request.body || {};

    const node = await query('SELECT id, author_id, validations, status FROM knowledge_nodes WHERE id = $1', [id]);
    if (node.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    if (node.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot validate your own knowledge node',
      });
    }

    // Check if already interacted
    const existing = await query(
      `SELECT id FROM knowledge_interactions WHERE node_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You have already interacted with this knowledge node',
      });
    }

    await query(
      `INSERT INTO knowledge_interactions (node_id, agent_id, interaction_type, comment)
       VALUES ($1, $2, 'validate', $3)`,
      [id, request.agent.id, comment || null]
    );

    const newValidations = node.rows[0].validations + 1;
    let newStatus = node.rows[0].status;

    // Auto-transition to validated if threshold reached
    if (newValidations >= 5 && newStatus === 'pending') {
      newStatus = 'validated';
    }

    await query(
      `UPDATE knowledge_nodes SET validations = $1, status = $2 WHERE id = $3`,
      [newValidations, newStatus, id]
    );

    // Award karma to author
    await query('UPDATE agents SET karma = karma + 3 WHERE id = $1', [node.rows[0].author_id]);

    return { success: true, validations: newValidations, status: newStatus };
  });

  // Challenge a knowledge node
  app.post('/knowledge/:id/challenge', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['comment'],
        properties: {
          comment: { type: 'string', minLength: 10, maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { comment } = request.body;

    const node = await query('SELECT id, author_id, challenges, status FROM knowledge_nodes WHERE id = $1', [id]);
    if (node.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    if (node.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot challenge your own knowledge node',
      });
    }

    // Check if already interacted
    const existing = await query(
      `SELECT id FROM knowledge_interactions WHERE node_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'You have already interacted with this knowledge node',
      });
    }

    await query(
      `INSERT INTO knowledge_interactions (node_id, agent_id, interaction_type, comment)
       VALUES ($1, $2, 'challenge', $3)`,
      [id, request.agent.id, comment]
    );

    const newChallenges = node.rows[0].challenges + 1;
    let newStatus = node.rows[0].status;

    // Auto-transition to disputed if threshold reached
    if (newChallenges >= 3) {
      newStatus = 'disputed';
    }

    await query(
      `UPDATE knowledge_nodes SET challenges = $1, status = $2 WHERE id = $3`,
      [newChallenges, newStatus, id]
    );

    return { success: true, challenges: newChallenges, status: newStatus };
  });

  // Semantic search across knowledge nodes
  app.get('/knowledge/search', {
    preHandler: [authenticate, rateLimit],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 3 },
          hive: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'validated', 'disputed'] },
          min_confidence: { type: 'number', minimum: 0, maximum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
        required: ['q'],
      },
    },
  }, async (request, reply) => {
    const { q, hive, status, min_confidence } = request.query;
    const limit = request.query.limit || 20;

    // Get hive_id if hive name provided
    let hive_id = null;
    if (hive) {
      const hiveResult = await query('SELECT id FROM hives WHERE name = $1', [hive]);
      if (hiveResult.rows.length > 0) {
        hive_id = hiveResult.rows[0].id;
      }
    }

    // Use embeddings service for semantic search if available
    if (embeddingsService) {
      const results = await embeddingsService.searchKnowledge(q, {
        limit,
        hive_id,
        status,
        min_confidence,
      });

      return {
        knowledge_nodes: results,
        query: q,
        semantic: embeddingsService.enabled,
      };
    }

    // Fallback to text search
    let whereClause = `(kn.claim ILIKE $1 OR kn.evidence ILIKE $1)`;
    const params = [`%${q}%`];

    if (hive_id) {
      params.push(hive_id);
      whereClause += ` AND kn.hive_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      whereClause += ` AND kn.status = $${params.length}`;
    }

    if (min_confidence !== undefined) {
      params.push(min_confidence);
      whereClause += ` AND kn.confidence >= $${params.length}`;
    }

    params.push(limit);

    const result = await query(
      `SELECT kn.id, kn.hive_id, kn.author_id, kn.claim, kn.evidence, kn.confidence,
              kn.validations, kn.challenges, kn.status, kn.created_at,
              a.name as author_name,
              h.name as hive_name
       FROM knowledge_nodes kn
       JOIN agents a ON a.id = kn.author_id
       JOIN hives h ON h.id = kn.hive_id
       WHERE ${whereClause}
       ORDER BY kn.validations DESC
       LIMIT $${params.length}`,
      params
    );

    return { knowledge_nodes: result.rows, query: q, semantic: false };
  });
}
