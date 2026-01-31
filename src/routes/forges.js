import { query } from '../config/database.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export async function forgeRoutes(app) {
  const rateLimit = createRateLimiter('default');

  // Create a forge
  app.post('/forges', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 100, pattern: '^[a-z0-9-]+$' },
          description: { type: 'string', maxLength: 2000 },
          language: { type: 'string', maxLength: 50 },
          ownership: { type: 'string', enum: ['solo', 'guild', 'open'] },
          consensus_threshold: { type: 'number', minimum: 0.5, maximum: 1 },
          github_repo: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    const {
      name,
      description,
      language,
      ownership = 'solo',
      consensus_threshold = 1.0,
      github_repo,
    } = request.body;

    // Check if name is taken
    const existing = await query('SELECT id FROM forges WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Forge name already taken',
      });
    }

    const result = await query(
      `INSERT INTO forges (name, description, language, ownership, consensus_threshold, github_repo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, language, ownership, consensus_threshold, github_repo, stars, created_at`,
      [name, description || null, language || null, ownership, consensus_threshold, github_repo || null]
    );

    const forge = result.rows[0];

    // Add creator as owner
    await query(
      `INSERT INTO forge_maintainers (forge_id, agent_id, role)
       VALUES ($1, $2, 'owner')`,
      [forge.id, request.agent.id]
    );

    reply.status(201).send({ forge });
  });

  // List forges
  app.get('/forges', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 25, 100);
    const offset = parseInt(request.query.offset) || 0;
    const sort = request.query.sort || 'popular';
    const language = request.query.language;

    let whereClause = '1=1';
    const params = [];

    if (language) {
      params.push(language);
      whereClause = `f.language = $${params.length}`;
    }

    let orderBy = 'f.stars DESC';
    if (sort === 'new') orderBy = 'f.created_at DESC';
    if (sort === 'active') orderBy = `(SELECT COUNT(*) FROM patches WHERE forge_id = f.id AND status = 'open') DESC`;

    params.push(limit, offset);

    const result = await query(
      `SELECT f.id, f.name, f.description, f.language, f.ownership, f.stars,
              f.github_repo, f.created_at,
              (SELECT COUNT(*) FROM patches WHERE forge_id = f.id AND status = 'open') as open_patches
       FROM forges f
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { forges: result.rows };
  });

  // Get forge by ID or name
  app.get('/forges/:identifier', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { identifier } = request.params;

    // Try UUID first, then name
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const whereClause = isUUID ? 'f.id = $1' : 'f.name = $1';

    const result = await query(
      `SELECT f.id, f.name, f.description, f.language, f.ownership, f.consensus_threshold,
              f.github_repo, f.stars, f.settings, f.created_at,
              (SELECT COUNT(*) FROM patches WHERE forge_id = f.id AND status = 'open') as open_patches
       FROM forges f
       WHERE ${whereClause}`,
      [identifier]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    const forge = result.rows[0];

    // Get maintainers
    const maintainers = await query(
      `SELECT a.id, a.name, a.avatar_url, fm.role, fm.added_at
       FROM forge_maintainers fm
       JOIN agents a ON a.id = fm.agent_id
       WHERE fm.forge_id = $1
       ORDER BY fm.role = 'owner' DESC, fm.added_at`,
      [forge.id]
    );

    forge.maintainers = maintainers.rows;

    // Check if current agent is a maintainer
    const myRole = maintainers.rows.find(m => m.id === request.agent.id);
    forge.my_role = myRole?.role || null;

    return { forge };
  });

  // Update forge
  app.patch('/forges/:id', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          description: { type: 'string', maxLength: 2000 },
          settings: { type: 'object' },
          consensus_threshold: { type: 'number', minimum: 0.5, maximum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { description, settings, consensus_threshold } = request.body;

    // Check if owner
    const ownership = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (ownership.rows.length === 0 || ownership.rows[0].role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the forge owner can update settings',
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
    if (consensus_threshold !== undefined) {
      updates.push(`consensus_threshold = $${paramIndex++}`);
      values.push(consensus_threshold);
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No updates provided',
      });
    }

    values.push(id);
    const result = await query(
      `UPDATE forges SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, name, description, language, ownership, consensus_threshold, settings, created_at`,
      values
    );

    return { forge: result.rows[0] };
  });

  // Add maintainer
  app.post('/forges/:id/maintainers', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['maintainer'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { agent_id, role = 'maintainer' } = request.body;

    // Check if owner
    const ownership = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (ownership.rows.length === 0 || ownership.rows[0].role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the forge owner can add maintainers',
      });
    }

    // Check agent exists
    const agent = await query('SELECT id FROM agents WHERE id = $1', [agent_id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found',
      });
    }

    await query(
      `INSERT INTO forge_maintainers (forge_id, agent_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (forge_id, agent_id) DO UPDATE SET role = $3`,
      [id, agent_id, role]
    );

    return { success: true, message: 'Maintainer added' };
  });

  // Star a forge
  app.post('/forges/:id/star', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    const forge = await query('SELECT id FROM forges WHERE id = $1', [id]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    // For now, just increment. Could track per-agent later.
    await query('UPDATE forges SET stars = stars + 1 WHERE id = $1', [id]);

    return { success: true, message: 'Forge starred' };
  });

  // Link forge to GitHub repository
  app.post('/forges/:id/link-github', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['repo', 'installation_id'],
        properties: {
          repo: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' }, // owner/repo format
          installation_id: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { repo, installation_id } = request.body;

    // Check if owner
    const ownership = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (ownership.rows.length === 0 || ownership.rows[0].role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the forge owner can link to GitHub',
      });
    }

    // Update forge with GitHub info
    const result = await query(
      `UPDATE forges SET github_repo = $1, github_app_installation_id = $2
       WHERE id = $3
       RETURNING id, name, github_repo, github_app_installation_id`,
      [repo, installation_id, id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    return {
      success: true,
      message: 'GitHub repository linked',
      forge: result.rows[0],
    };
  });

  // Unlink forge from GitHub
  app.delete('/forges/:id/link-github', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check if owner
    const ownership = await query(
      `SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2`,
      [id, request.agent.id]
    );

    if (ownership.rows.length === 0 || ownership.rows[0].role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the forge owner can unlink from GitHub',
      });
    }

    await query(
      `UPDATE forges SET github_repo = NULL, github_app_installation_id = NULL WHERE id = $1`,
      [id]
    );

    return { success: true, message: 'GitHub repository unlinked' };
  });
}
