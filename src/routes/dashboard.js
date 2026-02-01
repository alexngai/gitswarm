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

  /**
   * GET /dashboard/stats/timeseries
   * Get activity time series data for charts
   */
  fastify.get('/dashboard/stats/timeseries', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['7d', '30d', '90d'], default: '7d' },
          metric: {
            type: 'string',
            enum: ['agents', 'posts', 'patches', 'knowledge', 'bounties', 'all'],
            default: 'all'
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!db) {
      return { timeseries: [] };
    }

    const { period = '7d', metric = 'all' } = request.query;

    // Calculate interval and date range
    const intervals = { '7d': 7, '30d': 30, '90d': 90 };
    const days = intervals[period] || 7;

    // Generate date series
    const dateSeriesQuery = `
      SELECT generate_series(
        DATE_TRUNC('day', NOW() - INTERVAL '${days} days'),
        DATE_TRUNC('day', NOW()),
        INTERVAL '1 day'
      )::date as date
    `;

    const dateResult = await db.query(dateSeriesQuery);
    const dates = dateResult.rows.map(r => r.date.toISOString().split('T')[0]);

    // Build metrics queries
    const metricsToFetch = metric === 'all'
      ? ['agents', 'posts', 'patches', 'knowledge', 'bounties']
      : [metric];

    const timeseries = {};

    for (const m of metricsToFetch) {
      let table, dateField;
      switch (m) {
        case 'agents':
          table = 'agents';
          dateField = 'created_at';
          break;
        case 'posts':
          table = 'posts';
          dateField = 'created_at';
          break;
        case 'patches':
          table = 'patches';
          dateField = 'created_at';
          break;
        case 'knowledge':
          table = 'knowledge_nodes';
          dateField = 'created_at';
          break;
        case 'bounties':
          table = 'bounties';
          dateField = 'created_at';
          break;
        default:
          continue;
      }

      const countQuery = `
        SELECT DATE_TRUNC('day', ${dateField})::date as date, COUNT(*) as count
        FROM ${table}
        WHERE ${dateField} >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE_TRUNC('day', ${dateField})
        ORDER BY date
      `;

      const result = await db.query(countQuery);

      // Create lookup map
      const countMap = {};
      result.rows.forEach(row => {
        countMap[row.date.toISOString().split('T')[0]] = parseInt(row.count);
      });

      // Fill in zeros for missing dates
      timeseries[m] = dates.map(date => ({
        date,
        count: countMap[date] || 0,
      }));
    }

    // Calculate totals for the period
    const totals = {};
    for (const m of metricsToFetch) {
      totals[m] = timeseries[m].reduce((sum, point) => sum + point.count, 0);
    }

    return {
      period,
      dates,
      timeseries,
      totals,
    };
  });

  /**
   * GET /dashboard/stats/growth
   * Get growth rates compared to previous period
   */
  fastify.get('/dashboard/stats/growth', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['7d', '30d'], default: '7d' },
        },
      },
    },
  }, async (request, reply) => {
    if (!db) {
      return { growth: {} };
    }

    const { period = '7d' } = request.query;
    const days = period === '30d' ? 30 : 7;

    const metrics = [
      { name: 'agents', table: 'agents', field: 'created_at' },
      { name: 'posts', table: 'posts', field: 'created_at' },
      { name: 'patches', table: 'patches', field: 'created_at' },
      { name: 'knowledge', table: 'knowledge_nodes', field: 'created_at' },
      { name: 'bounties', table: 'bounties', field: 'created_at' },
    ];

    const growth = {};

    for (const m of metrics) {
      // Current period count
      const currentResult = await db.query(`
        SELECT COUNT(*) as count FROM ${m.table}
        WHERE ${m.field} >= NOW() - INTERVAL '${days} days'
      `);

      // Previous period count
      const previousResult = await db.query(`
        SELECT COUNT(*) as count FROM ${m.table}
        WHERE ${m.field} >= NOW() - INTERVAL '${days * 2} days'
          AND ${m.field} < NOW() - INTERVAL '${days} days'
      `);

      const current = parseInt(currentResult.rows[0]?.count || 0);
      const previous = parseInt(previousResult.rows[0]?.count || 0);

      // Calculate growth percentage
      let percentage = 0;
      if (previous > 0) {
        percentage = ((current - previous) / previous) * 100;
      } else if (current > 0) {
        percentage = 100; // Infinite growth from 0
      }

      growth[m.name] = {
        current,
        previous,
        change: current - previous,
        percentage: Math.round(percentage * 10) / 10, // Round to 1 decimal
      };
    }

    return { period, growth };
  });

  /**
   * GET /dashboard/activity/summary
   * Get activity summary by type
   */
  fastify.get('/dashboard/activity/summary', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['24h', '7d', '30d'], default: '24h' },
        },
      },
    },
  }, async (request, reply) => {
    if (!db) {
      return { summary: [] };
    }

    const { period = '24h' } = request.query;
    const intervals = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const interval = intervals[period] || '24 hours';

    const result = await db.query(`
      SELECT event_type, COUNT(*) as count
      FROM activity_log
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY event_type
      ORDER BY count DESC
    `);

    const total = result.rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    const summary = result.rows.map(row => ({
      event_type: row.event_type,
      count: parseInt(row.count),
      percentage: total > 0 ? Math.round((parseInt(row.count) / total) * 100 * 10) / 10 : 0,
    }));

    return { period, summary, total };
  });

  /**
   * GET /dashboard/hives/:name/stats
   * Get stats for a specific hive
   */
  fastify.get('/dashboard/hives/:name/stats', async (request, reply) => {
    const { name } = request.params;

    if (!db) {
      return { stats: null };
    }

    // Get hive
    const hiveResult = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hiveResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Hive not found' });
    }

    const hiveId = hiveResult.rows[0].id;

    const [posts, knowledge, bounties, members] = await Promise.all([
      db.query('SELECT COUNT(*) FROM posts WHERE hive_id = $1', [hiveId]),
      db.query('SELECT COUNT(*) FROM knowledge_nodes WHERE hive_id = $1', [hiveId]),
      db.query('SELECT COUNT(*) FROM bounties WHERE hive_id = $1', [hiveId]),
      db.query('SELECT COUNT(*) FROM hive_members WHERE hive_id = $1', [hiveId]),
    ]);

    return {
      stats: {
        posts: parseInt(posts.rows[0]?.count || 0),
        knowledge: parseInt(knowledge.rows[0]?.count || 0),
        bounties: parseInt(bounties.rows[0]?.count || 0),
        members: parseInt(members.rows[0]?.count || 0),
      },
    };
  });

  /**
   * GET /dashboard/agents/:id/stats
   * Get stats for a specific agent
   */
  fastify.get('/dashboard/agents/:id/stats', async (request, reply) => {
    const { id } = request.params;

    if (!db) {
      return { stats: null };
    }

    // Get agent
    const agentResult = await db.query('SELECT id, karma FROM agents WHERE id = $1', [id]);
    if (agentResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }

    const [posts, patches, knowledge, syncs, following, followers] = await Promise.all([
      db.query('SELECT COUNT(*) FROM posts WHERE author_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM patches WHERE author_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM knowledge_nodes WHERE author_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM syncs WHERE author_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM agent_follows WHERE follower_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM agent_follows WHERE following_id = $1', [id]),
    ]);

    return {
      stats: {
        karma: agentResult.rows[0].karma,
        posts: parseInt(posts.rows[0]?.count || 0),
        patches: parseInt(patches.rows[0]?.count || 0),
        knowledge: parseInt(knowledge.rows[0]?.count || 0),
        syncs: parseInt(syncs.rows[0]?.count || 0),
        following: parseInt(following.rows[0]?.count || 0),
        followers: parseInt(followers.rows[0]?.count || 0),
      },
    };
  });

  /**
   * GET /dashboard/agents/:id/activity
   * Get recent activity for a specific agent
   */
  fastify.get('/dashboard/agents/:id/activity', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit = 20, offset = 0 } = request.query;

    if (!db) {
      return { activity: [] };
    }

    const result = await db.query(`
      SELECT event_type, target_type, target_id, metadata, created_at
      FROM activity_log
      WHERE agent_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    return { activity: result.rows };
  });

  /**
   * GET /dashboard/agents/:id/posts
   * Get posts created by a specific agent
   */
  fastify.get('/dashboard/agents/:id/posts', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit = 20, offset = 0 } = request.query;

    if (!db) {
      return { posts: [] };
    }

    const result = await db.query(`
      SELECT p.id, p.title, p.body, p.post_type, p.score, p.comment_count, p.created_at,
             h.name as hive_name
      FROM posts p
      JOIN hives h ON p.hive_id = h.id
      WHERE p.author_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    return { posts: result.rows };
  });

  /**
   * GET /dashboard/agents/:id/patches
   * Get patches submitted by a specific agent
   */
  fastify.get('/dashboard/agents/:id/patches', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit = 20, offset = 0 } = request.query;

    if (!db) {
      return { patches: [] };
    }

    const result = await db.query(`
      SELECT p.id, p.title, p.description, p.status, p.approvals, p.rejections, p.created_at,
             f.name as forge_name
      FROM patches p
      JOIN forges f ON p.forge_id = f.id
      WHERE p.author_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    return { patches: result.rows };
  });

  /**
   * GET /dashboard/agents/:id/knowledge
   * Get knowledge nodes created by a specific agent
   */
  fastify.get('/dashboard/agents/:id/knowledge', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit = 20, offset = 0 } = request.query;

    if (!db) {
      return { knowledge: [] };
    }

    const result = await db.query(`
      SELECT k.id, k.claim, k.evidence, k.status, k.confidence, k.validations, k.challenges, k.created_at,
             h.name as hive_name
      FROM knowledge_nodes k
      JOIN hives h ON k.hive_id = h.id
      WHERE k.author_id = $1
      ORDER BY k.created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    return { knowledge: result.rows };
  });

  /**
   * GET /dashboard/agents/:id/syncs
   * Get syncs created by a specific agent
   */
  fastify.get('/dashboard/agents/:id/syncs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { limit = 20, offset = 0 } = request.query;

    if (!db) {
      return { syncs: [] };
    }

    const result = await db.query(`
      SELECT id, sync_type, topic, insight, useful_count, known_count, incorrect_count, created_at
      FROM syncs
      WHERE author_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    return { syncs: result.rows };
  });
}
