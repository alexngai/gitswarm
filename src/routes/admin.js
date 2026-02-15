/**
 * Admin Routes
 * Moderation and administrative functions for human admins
 */

import { query } from '../config/database.js';
import { sessions } from './auth.js';

// Middleware to require admin role
function requireAdmin(request, reply, done) {
  if (!request.user) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }

  if (request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
    return;
  }

  done();
}

export default async function adminRoutes(fastify, options) {
  const { db } = options;

  // All routes require admin authentication
  fastify.addHook('preHandler', async (request, reply) => {
    // Check for session cookie
    const sessionId = request.cookies?.bothub_session;
    if (!sessionId) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    // BUG-4 fix: Validate session against server-side session store
    // (previously decoded base64 client-side, allowing forged sessions)
    const session = sessions.get(sessionId);
    if (!session) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid session' });
    }

    if (session.expires < Date.now()) {
      sessions.delete(sessionId);
      return reply.status(401).send({ error: 'Unauthorized', message: 'Session expired' });
    }

    if (!session.user || session.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
    }

    request.user = session.user;
  });

  /**
   * GET /admin/reports
   * List pending reports
   */
  fastify.get('/admin/reports', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'resolved', 'dismissed'], default: 'pending' },
          target_type: { type: 'string', enum: ['post', 'comment', 'agent', 'knowledge', 'sync'] },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { status = 'pending', target_type, limit = 50, offset = 0 } = request.query;

    let whereClause = 'r.status = $1';
    const params = [status];

    if (target_type) {
      params.push(target_type);
      whereClause += ` AND r.target_type = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT r.id, r.reporter_id, r.target_type, r.target_id, r.reason, r.description,
              r.status, r.created_at, r.resolved_at, r.resolved_by,
              a.name as reporter_name,
              hu.name as resolved_by_name
       FROM reports r
       LEFT JOIN agents a ON r.reporter_id = a.id
       LEFT JOIN human_users hu ON r.resolved_by = hu.id
       WHERE ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Get counts by status
    const counts = await query(`
      SELECT status, COUNT(*) as count
      FROM reports
      GROUP BY status
    `);

    const statusCounts = {};
    counts.rows.forEach(row => {
      statusCounts[row.status] = parseInt(row.count);
    });

    return {
      reports: result.rows,
      counts: statusCounts,
    };
  });

  /**
   * GET /admin/reports/:id
   * Get report details with target content
   */
  fastify.get('/admin/reports/:id', async (request, reply) => {
    const { id } = request.params;

    const reportResult = await query(
      `SELECT r.*, a.name as reporter_name
       FROM reports r
       LEFT JOIN agents a ON r.reporter_id = a.id
       WHERE r.id = $1`,
      [id]
    );

    if (reportResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Report not found' });
    }

    const report = reportResult.rows[0];

    // Fetch target content
    let targetContent = null;
    switch (report.target_type) {
      case 'post':
        const post = await query(
          `SELECT p.*, a.name as author_name FROM posts p JOIN agents a ON p.author_id = a.id WHERE p.id = $1`,
          [report.target_id]
        );
        targetContent = post.rows[0];
        break;
      case 'comment':
        const comment = await query(
          `SELECT c.*, a.name as author_name FROM comments c JOIN agents a ON c.author_id = a.id WHERE c.id = $1`,
          [report.target_id]
        );
        targetContent = comment.rows[0];
        break;
      case 'agent':
        const agent = await query(
          `SELECT id, name, bio, karma, status, created_at FROM agents WHERE id = $1`,
          [report.target_id]
        );
        targetContent = agent.rows[0];
        break;
      case 'knowledge':
        const knowledge = await query(
          `SELECT k.*, a.name as author_name FROM knowledge_nodes k JOIN agents a ON k.author_id = a.id WHERE k.id = $1`,
          [report.target_id]
        );
        targetContent = knowledge.rows[0];
        break;
      case 'sync':
        const sync = await query(
          `SELECT s.*, a.name as author_name FROM syncs s JOIN agents a ON s.author_id = a.id WHERE s.id = $1`,
          [report.target_id]
        );
        targetContent = sync.rows[0];
        break;
    }

    return { report, targetContent };
  });

  /**
   * POST /admin/reports/:id/resolve
   * Resolve a report (dismiss or take action)
   */
  fastify.post('/admin/reports/:id/resolve', {
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['dismiss', 'remove_content', 'warn_agent', 'ban_agent'] },
          note: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { action, note } = request.body;

    const reportResult = await query(
      `SELECT * FROM reports WHERE id = $1`,
      [id]
    );

    if (reportResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Report not found' });
    }

    const report = reportResult.rows[0];

    if (report.status !== 'pending') {
      return reply.status(400).send({ error: 'Bad Request', message: 'Report already resolved' });
    }

    // Perform action
    let actionResult = {};
    switch (action) {
      case 'dismiss':
        // Just mark as dismissed
        actionResult.message = 'Report dismissed';
        break;

      case 'remove_content':
        // Delete the reported content
        switch (report.target_type) {
          case 'post':
            await query('DELETE FROM posts WHERE id = $1', [report.target_id]);
            break;
          case 'comment':
            await query('DELETE FROM comments WHERE id = $1', [report.target_id]);
            break;
          case 'knowledge':
            await query('DELETE FROM knowledge_nodes WHERE id = $1', [report.target_id]);
            break;
          case 'sync':
            await query('DELETE FROM syncs WHERE id = $1', [report.target_id]);
            break;
        }
        actionResult.message = 'Content removed';
        break;

      case 'warn_agent': {
        // BUG-3 fix: Use allowlist to prevent SQL injection via target_type
        const warnTableMap = { post: 'posts', comment: 'comments', knowledge: 'knowledge_nodes', agent: 'agents', sync: 'syncs' };
        let agentId = report.target_type === 'agent' ? report.target_id : null;
        if (!agentId) {
          const tableName = warnTableMap[report.target_type];
          if (!tableName) break;
          const contentResult = await query(
            `SELECT author_id FROM ${tableName} WHERE id = $1`,
            [report.target_id]
          );
          agentId = contentResult.rows[0]?.author_id;
        }
        if (agentId) {
          // Deduct karma as warning
          await query('UPDATE agents SET karma = karma - 10 WHERE id = $1', [agentId]);
          actionResult.message = 'Agent warned (-10 karma)';
        }
        break;
      }

      case 'ban_agent': {
        // BUG-3 fix: Use allowlist to prevent SQL injection via target_type
        const banTableMap = { post: 'posts', comment: 'comments', knowledge: 'knowledge_nodes', agent: 'agents', sync: 'syncs' };
        let targetAgentId = report.target_type === 'agent' ? report.target_id : null;
        if (!targetAgentId) {
          const tableName = banTableMap[report.target_type];
          if (!tableName) break;
          const contentResult = await query(
            `SELECT author_id FROM ${tableName} WHERE id = $1`,
            [report.target_id]
          );
          targetAgentId = contentResult.rows[0]?.author_id;
        }
        if (targetAgentId) {
          await query("UPDATE agents SET status = 'banned' WHERE id = $1", [targetAgentId]);
          actionResult.message = 'Agent banned';
        }
        break;
      }
    }

    // Update report status
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    await query(
      `UPDATE reports SET status = $1, resolved_by = $2, resolved_at = NOW() WHERE id = $3`,
      [status, request.user.id, id]
    );

    return { success: true, action, ...actionResult };
  });

  /**
   * GET /admin/agents
   * List agents with moderation info
   */
  fastify.get('/admin/agents', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'banned', 'suspended'] },
          search: { type: 'string' },
          sort: { type: 'string', enum: ['karma', 'created_at', 'name', 'reports'], default: 'created_at' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { status, search, sort = 'created_at', limit = 50, offset = 0 } = request.query;

    let whereClause = '1=1';
    const params = [];

    if (status) {
      params.push(status);
      whereClause += ` AND a.status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (a.name ILIKE $${params.length} OR a.bio ILIKE $${params.length})`;
    }

    const sortColumns = {
      karma: 'a.karma DESC',
      created_at: 'a.created_at DESC',
      name: 'a.name ASC',
      reports: 'report_count DESC',
    };

    params.push(limit, offset);

    const result = await query(
      `SELECT a.id, a.name, a.bio, a.karma, a.status, a.created_at, a.verified,
              COUNT(r.id) as report_count
       FROM agents a
       LEFT JOIN reports r ON r.target_type = 'agent' AND r.target_id = a.id
       WHERE ${whereClause}
       GROUP BY a.id
       ORDER BY ${sortColumns[sort] || 'a.created_at DESC'}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { agents: result.rows };
  });

  /**
   * POST /admin/agents/:id/ban
   * Ban an agent
   */
  fastify.post('/admin/agents/:id/ban', {
    schema: {
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { reason } = request.body || {};

    const agent = await query('SELECT id, status FROM agents WHERE id = $1', [id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }

    if (agent.rows[0].status === 'banned') {
      return reply.status(400).send({ error: 'Bad Request', message: 'Agent already banned' });
    }

    await query("UPDATE agents SET status = 'banned' WHERE id = $1", [id]);

    // Log the action (could also create an audit log entry)
    console.log(`Agent ${id} banned by admin ${request.user.id}. Reason: ${reason || 'No reason provided'}`);

    return { success: true, message: 'Agent banned' };
  });

  /**
   * POST /admin/agents/:id/unban
   * Unban an agent
   */
  fastify.post('/admin/agents/:id/unban', async (request, reply) => {
    const { id } = request.params;

    const agent = await query('SELECT id, status FROM agents WHERE id = $1', [id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }

    if (agent.rows[0].status !== 'banned') {
      return reply.status(400).send({ error: 'Bad Request', message: 'Agent is not banned' });
    }

    await query("UPDATE agents SET status = 'active' WHERE id = $1", [id]);

    console.log(`Agent ${id} unbanned by admin ${request.user.id}`);

    return { success: true, message: 'Agent unbanned' };
  });

  /**
   * POST /admin/agents/:id/verify
   * Verify an agent (mark as trusted)
   */
  fastify.post('/admin/agents/:id/verify', async (request, reply) => {
    const { id } = request.params;

    const agent = await query('SELECT id, verified FROM agents WHERE id = $1', [id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }

    await query('UPDATE agents SET verified = true, verified_at = NOW() WHERE id = $1', [id]);

    return { success: true, message: 'Agent verified' };
  });

  /**
   * GET /admin/audit-log
   * View admin actions (simplified - could be expanded with proper audit table)
   */
  fastify.get('/admin/audit-log', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { limit = 50, offset = 0 } = request.query;

    // For now, return resolved reports as audit log
    const result = await query(
      `SELECT r.id, r.target_type, r.target_id, r.status, r.resolved_at,
              hu.name as admin_name, hu.email as admin_email
       FROM reports r
       JOIN human_users hu ON r.resolved_by = hu.id
       WHERE r.status != 'pending'
       ORDER BY r.resolved_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { audit_log: result.rows };
  });
}
