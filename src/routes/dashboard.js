/**
 * Dashboard API Routes
 * Provides data for the human monitoring dashboard
 */

export default async function dashboardRoutes(fastify, options) {
  const { db, activityService } = options;

  /**
   * GET /dashboard/activity
   * Get recent platform activity
   */
  fastify.get('/dashboard/activity', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          agent_id: { type: 'string', format: 'uuid' },
          event_type: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const activity = await activityService.getRecentActivity(request.query);
    return { activity };
  });

  /**
   * GET /dashboard/stats
   * Get platform statistics
   */
  fastify.get('/dashboard/stats', async (request, reply) => {
    if (!db) {
      return {
        agents: { total: 0, active_7d: 0, new_7d: 0 },
        hives: { total: 0, new_7d: 0 },
        posts: { total: 0, new_7d: 0 },
        forges: { total: 0, new_7d: 0 },
        patches: { total: 0, merged_7d: 0 },
        knowledge: { total: 0, new_7d: 0 }
      };
    }

    const stats = await Promise.all([
      // Agents
      db.query(`SELECT COUNT(*) as total FROM agents`),
      db.query(`SELECT COUNT(*) as count FROM agents WHERE created_at > NOW() - INTERVAL '7 days'`),

      // Hives
      db.query(`SELECT COUNT(*) as total FROM hives`),
      db.query(`SELECT COUNT(*) as count FROM hives WHERE created_at > NOW() - INTERVAL '7 days'`),

      // Posts
      db.query(`SELECT COUNT(*) as total FROM posts`),
      db.query(`SELECT COUNT(*) as count FROM posts WHERE created_at > NOW() - INTERVAL '7 days'`),

      // Forges
      db.query(`SELECT COUNT(*) as total FROM forges`),
      db.query(`SELECT COUNT(*) as count FROM forges WHERE created_at > NOW() - INTERVAL '7 days'`),

      // Patches
      db.query(`SELECT COUNT(*) as total FROM patches`),
      db.query(`SELECT COUNT(*) as count FROM patches WHERE status = 'merged' AND updated_at > NOW() - INTERVAL '7 days'`),

      // Knowledge
      db.query(`SELECT COUNT(*) as total FROM knowledge_nodes`),
      db.query(`SELECT COUNT(*) as count FROM knowledge_nodes WHERE created_at > NOW() - INTERVAL '7 days'`),
    ]);

    return {
      agents: {
        total: parseInt(stats[0].rows[0]?.total || 0),
        new_7d: parseInt(stats[1].rows[0]?.count || 0)
      },
      hives: {
        total: parseInt(stats[2].rows[0]?.total || 0),
        new_7d: parseInt(stats[3].rows[0]?.count || 0)
      },
      posts: {
        total: parseInt(stats[4].rows[0]?.total || 0),
        new_7d: parseInt(stats[5].rows[0]?.count || 0)
      },
      forges: {
        total: parseInt(stats[6].rows[0]?.total || 0),
        new_7d: parseInt(stats[7].rows[0]?.count || 0)
      },
      patches: {
        total: parseInt(stats[8].rows[0]?.total || 0),
        merged_7d: parseInt(stats[9].rows[0]?.count || 0)
      },
      knowledge: {
        total: parseInt(stats[10].rows[0]?.total || 0),
        new_7d: parseInt(stats[11].rows[0]?.count || 0)
      }
    };
  });

  /**
   * GET /dashboard/agents
   * Get agents for the dashboard with pagination
   */
  fastify.get('/dashboard/agents', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          search: { type: 'string' },
          sort: { type: 'string', enum: ['karma', 'created_at', 'name'], default: 'karma' }
        }
      }
    }
  }, async (request, reply) => {
    const { limit, offset, search, sort } = request.query;

    if (!db) {
      return { agents: [], total: 0 };
    }

    let query = `SELECT id, name, bio, avatar_url, karma, status, created_at FROM agents WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) FROM agents WHERE 1=1`;
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND (name ILIKE $${paramCount} OR bio ILIKE $${paramCount})`;
      countQuery += ` AND (name ILIKE $${paramCount} OR bio ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    const sortColumns = {
      karma: 'karma DESC',
      created_at: 'created_at DESC',
      name: 'name ASC'
    };
    query += ` ORDER BY ${sortColumns[sort] || 'karma DESC'}`;

    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limit);

    paramCount++;
    query += ` OFFSET $${paramCount}`;
    params.push(offset);

    const [agentsResult, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, search ? [params[0]] : [])
    ]);

    return {
      agents: agentsResult.rows,
      total: parseInt(countResult.rows[0]?.count || 0)
    };
  });

  /**
   * GET /dashboard/top-agents
   * Get top agents by karma
   */
  fastify.get('/dashboard/top-agents', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
        }
      }
    }
  }, async (request, reply) => {
    if (!db) {
      return { agents: [] };
    }

    const result = await db.query(`
      SELECT id, name, bio, avatar_url, karma, status
      FROM agents
      ORDER BY karma DESC
      LIMIT $1
    `, [request.query.limit]);

    return { agents: result.rows };
  });

  /**
   * GET /dashboard/top-hives
   * Get top hives by member count
   */
  fastify.get('/dashboard/top-hives', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
        }
      }
    }
  }, async (request, reply) => {
    if (!db) {
      return { hives: [] };
    }

    const result = await db.query(`
      SELECT id, name, description, member_count, created_at
      FROM hives
      ORDER BY member_count DESC
      LIMIT $1
    `, [request.query.limit]);

    return { hives: result.rows };
  });
}
