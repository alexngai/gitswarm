import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';
import { GitSwarmService, gitswarmService as defaultGitswarmService } from '../../services/gitswarm.js';

const permissionService = new GitSwarmPermissionService();

export async function gitswarmRoutes(app, options = {}) {
  const { activityService } = options;
  const gitswarmService = options.gitswarmService || defaultGitswarmService;

  // Different rate limits for different operation types
  const rateLimitRead = createRateLimiter('gitswarm_read');
  const rateLimitWrite = createRateLimiter('gitswarm_write');
  const rateLimitClone = createRateLimiter('gitswarm_clone');
  const rateLimitPR = createRateLimiter('gitswarm_pr');
  const rateLimitRepo = createRateLimiter('gitswarm_repo');
  const rateLimit = createRateLimiter('default');

  // ============================================================
  // Organization Routes
  // ============================================================

  // List organizations
  app.get('/gitswarm/orgs', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;
    const status = request.query.status || 'active';

    const result = await query(`
      SELECT
        o.id, o.github_org_name, o.is_platform_org, o.default_agent_access,
        o.default_min_karma, o.status, o.created_at,
        (SELECT COUNT(*) FROM gitswarm_repos WHERE org_id = o.id AND status = 'active') as repo_count
      FROM gitswarm_orgs o
      WHERE o.status = $1
      ORDER BY o.is_platform_org DESC, o.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const countResult = await query(`
      SELECT COUNT(*) as total FROM gitswarm_orgs WHERE status = $1
    `, [status]);

    return {
      orgs: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  });

  // Get organization by ID
  app.get('/gitswarm/orgs/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Try UUID first, then name
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const whereClause = isUUID ? 'o.id = $1' : 'o.github_org_name = $1';

    const result = await query(`
      SELECT
        o.id, o.github_org_name, o.github_org_id, o.github_installation_id,
        o.is_platform_org, o.default_agent_access, o.default_min_karma,
        o.status, o.owner_id, o.owner_type, o.created_at, o.updated_at, o.metadata
      FROM gitswarm_orgs o
      WHERE ${whereClause}
    `, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Organization not found'
      });
    }

    const org = result.rows[0];

    // Get repos for this org
    const repos = await query(`
      SELECT id, github_repo_name, github_full_name, is_private, description,
             ownership_model, stage, created_at
      FROM gitswarm_repos
      WHERE org_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 20
    `, [org.id]);

    org.repos = repos.rows;

    return { org };
  });

  // Update organization settings (owner only)
  app.patch('/gitswarm/orgs/:id', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          default_agent_access: { type: 'string', enum: ['none', 'public', 'karma_threshold', 'allowlist'] },
          default_min_karma: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { default_agent_access, default_min_karma } = request.body;

    // Check if org exists and agent is owner
    const org = await query(`
      SELECT id, owner_id FROM gitswarm_orgs WHERE id = $1
    `, [id]);

    if (org.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Organization not found'
      });
    }

    // For now, only the owner can update org settings
    // In the future, this could be extended to council members
    if (org.rows[0].owner_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the organization owner can update settings'
      });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (default_agent_access !== undefined) {
      updates.push(`default_agent_access = $${paramIndex++}`);
      values.push(default_agent_access);
    }
    if (default_min_karma !== undefined) {
      updates.push(`default_min_karma = $${paramIndex++}`);
      values.push(default_min_karma);
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No updates provided'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(`
      UPDATE gitswarm_orgs SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, github_org_name, default_agent_access, default_min_karma, updated_at
    `, values);

    return { org: result.rows[0] };
  });

  // ============================================================
  // Repository Routes
  // ============================================================

  // List repositories
  app.get('/gitswarm/repos', {
    preHandler: [authenticate, rateLimit],
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 50, 100);
    const offset = parseInt(request.query.offset) || 0;
    const orgId = request.query.org_id;
    const agentAccess = request.query.agent_access;
    const language = request.query.language;
    const search = request.query.q;
    const sort = request.query.sort || 'updated_at';
    const order = request.query.order === 'asc' ? 'ASC' : 'DESC';

    let whereClause = 'r.status = $1';
    const params = ['active'];
    let paramIndex = 2;

    if (orgId) {
      whereClause += ` AND r.org_id = $${paramIndex++}`;
      params.push(orgId);
    }
    if (agentAccess) {
      whereClause += ` AND (r.agent_access = $${paramIndex} OR (r.agent_access IS NULL AND o.default_agent_access = $${paramIndex}))`;
      params.push(agentAccess);
      paramIndex++;
    }
    if (language) {
      whereClause += ` AND r.primary_language = $${paramIndex++}`;
      params.push(language);
    }
    if (search) {
      whereClause += ` AND (r.github_repo_name ILIKE $${paramIndex} OR r.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const sortColumn = {
      'created_at': 'r.created_at',
      'updated_at': 'r.updated_at',
      'name': 'r.github_repo_name',
      'stage': 'r.stage'
    }[sort] || 'r.updated_at';

    params.push(limit, offset);

    const result = await query(`
      SELECT
        r.id, r.github_full_name, r.github_repo_name, r.description, r.is_private,
        r.ownership_model, r.primary_language, r.default_branch, r.stage,
        COALESCE(r.agent_access, o.default_agent_access) as agent_access,
        r.contributor_count, r.patch_count, r.created_at, r.updated_at,
        o.github_org_name, o.is_platform_org,
        (SELECT COUNT(*) FROM gitswarm_maintainers WHERE repo_id = r.id) as maintainer_count
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT $${paramIndex - 1} OFFSET $${paramIndex}
    `, params);

    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE ${whereClause}
    `, params.slice(0, -2));

    return {
      repos: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  });

  // Get repository by ID
  app.get('/gitswarm/repos/:id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Try UUID first, then full name (org/repo)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const whereClause = isUUID ? 'r.id = $1' : 'r.github_full_name = $1';

    const result = await query(`
      SELECT
        r.*,
        o.id as org_id, o.github_org_name, o.is_platform_org,
        o.default_agent_access, o.default_min_karma
      FROM gitswarm_repos r
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE ${whereClause}
    `, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Repository not found'
      });
    }

    const repo = result.rows[0];

    // Check if agent has read access
    const permissions = await permissionService.resolvePermissions(request.agent.id, repo.id);
    if (permissions.level === 'none') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    // Get maintainers
    const maintainers = await query(`
      SELECT a.id as agent_id, a.name, a.avatar_url, m.role, m.added_at
      FROM gitswarm_maintainers m
      JOIN agents a ON m.agent_id = a.id
      WHERE m.repo_id = $1
      ORDER BY m.role = 'owner' DESC, m.added_at
    `, [repo.id]);

    // Get branch rules
    const branchRules = await query(`
      SELECT id, branch_pattern, direct_push, required_approvals, require_tests_pass,
             consensus_threshold, merge_restriction, priority
      FROM gitswarm_branch_rules
      WHERE repo_id = $1
      ORDER BY priority DESC
    `, [repo.id]);

    // Format response
    const response = {
      repo: {
        id: repo.id,
        org: {
          id: repo.org_id,
          github_org_name: repo.github_org_name,
          is_platform_org: repo.is_platform_org
        },
        github_repo_name: repo.github_repo_name,
        github_full_name: repo.github_full_name,
        github_repo_id: repo.github_repo_id,
        description: repo.description,
        is_private: repo.is_private,
        ownership_model: repo.ownership_model,
        consensus_threshold: repo.consensus_threshold,
        min_reviews: repo.min_reviews,
        agent_access: repo.agent_access || repo.default_agent_access,
        min_karma: repo.min_karma ?? repo.default_min_karma,
        default_branch: repo.default_branch,
        primary_language: repo.primary_language,
        stage: repo.stage,
        contributor_count: repo.contributor_count,
        patch_count: repo.patch_count,
        human_review_weight: repo.human_review_weight,
        require_human_approval: repo.require_human_approval,
        human_can_force_merge: repo.human_can_force_merge,
        maintainers: maintainers.rows,
        branch_rules: branchRules.rows,
        your_access: {
          level: permissions.level,
          source: permissions.source
        },
        created_at: repo.created_at,
        updated_at: repo.updated_at
      }
    };

    return response;
  });

  // Create repository (platform org only for now)
  app.post('/gitswarm/repos', {
    preHandler: [authenticate, rateLimitRepo],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$' },
          description: { type: 'string', maxLength: 2000 },
          is_private: { type: 'boolean' },
          ownership_model: { type: 'string', enum: ['solo', 'guild', 'open'] },
          consensus_threshold: { type: 'number', minimum: 0.5, maximum: 1 },
          agent_access: { type: 'string', enum: ['none', 'public', 'karma_threshold', 'allowlist'] },
          min_karma: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const {
      name,
      description,
      is_private = false,
      ownership_model = 'open',
      consensus_threshold = 0.66,
      agent_access = 'public',
      min_karma
    } = request.body;

    // Get platform org
    const platformOrg = await query(`
      SELECT id, github_org_name, github_installation_id
      FROM gitswarm_orgs
      WHERE is_platform_org = true AND status = 'active'
      LIMIT 1
    `);

    if (platformOrg.rows.length === 0) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Platform organization not configured'
      });
    }

    const org = platformOrg.rows[0];

    // Check creation limits
    const limitCheck = await permissionService.checkRepoCreationLimit(request.agent.id);
    if (!limitCheck.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Repository creation limit reached: ${limitCheck.reason}`,
        limit: limitCheck.limit,
        used: limitCheck.used,
        karma: limitCheck.karma,
        required_karma: limitCheck.required_karma
      });
    }

    // Check if repo name is taken
    const existing = await query(`
      SELECT id FROM gitswarm_repos
      WHERE org_id = $1 AND github_repo_name = $2
    `, [org.id, name]);

    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Repository name already taken in this organization'
      });
    }

    // In a real implementation, we would create the repo on GitHub here
    // For now, we'll create the database record with a placeholder github_repo_id
    // The actual GitHub creation would happen via the GitSwarmService

    const fullName = `${org.github_org_name}/${name}`;

    // Generate a temporary repo ID (in production, this comes from GitHub)
    const tempGithubRepoId = Date.now();

    const result = await query(`
      INSERT INTO gitswarm_repos (
        org_id, github_repo_name, github_repo_id, github_full_name,
        is_private, description, ownership_model, consensus_threshold,
        agent_access, min_karma
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      org.id, name, tempGithubRepoId, fullName,
      is_private, description, ownership_model, consensus_threshold,
      agent_access, min_karma
    ]);

    const repo = result.rows[0];

    // Add creator as owner
    await query(`
      INSERT INTO gitswarm_maintainers (repo_id, agent_id, role, added_by)
      VALUES ($1, $2, 'owner', $2)
    `, [repo.id, request.agent.id]);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_repo_created',
        target_type: 'gitswarm_repo',
        target_id: repo.id,
        metadata: {
          agent_name: request.agent.name,
          repo_name: fullName,
          ownership_model
        }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({
      repo: {
        id: repo.id,
        github_full_name: fullName,
        github_repo_name: name,
        description,
        is_private,
        ownership_model,
        agent_access,
        created_at: repo.created_at
      }
    });
  });

  // Update repository settings
  app.patch('/gitswarm/repos/:id', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          description: { type: 'string', maxLength: 2000 },
          ownership_model: { type: 'string', enum: ['solo', 'guild', 'open'] },
          consensus_threshold: { type: 'number', minimum: 0.5, maximum: 1 },
          min_reviews: { type: 'integer', minimum: 1 },
          agent_access: { type: 'string', enum: ['none', 'public', 'karma_threshold', 'allowlist'] },
          min_karma: { type: 'integer', minimum: 0 },
          human_review_weight: { type: 'number', minimum: 0, maximum: 10 },
          require_human_approval: { type: 'boolean' },
          human_can_force_merge: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;

    // Check if repo exists
    const repo = await query(`SELECT id FROM gitswarm_repos WHERE id = $1`, [id]);
    if (repo.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Repository not found'
      });
    }

    // Check if agent is admin
    const canEdit = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canEdit.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can update settings'
      });
    }

    const allowedFields = [
      'description', 'ownership_model', 'consensus_threshold', 'min_reviews',
      'agent_access', 'min_karma', 'human_review_weight', 'require_human_approval',
      'human_can_force_merge'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex++}`);
        values.push(request.body[field]);
      }
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No updates provided'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(`
      UPDATE gitswarm_repos SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    return { repo: result.rows[0] };
  });

  // ============================================================
  // Maintainer Routes
  // ============================================================

  // List maintainers
  app.get('/gitswarm/repos/:id/maintainers', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check if repo exists and agent has read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    const result = await query(`
      SELECT a.id as agent_id, a.name, a.avatar_url, a.karma, m.role, m.added_at,
             ab.name as added_by_name
      FROM gitswarm_maintainers m
      JOIN agents a ON m.agent_id = a.id
      LEFT JOIN agents ab ON m.added_by = ab.id
      WHERE m.repo_id = $1
      ORDER BY m.role = 'owner' DESC, m.added_at
    `, [id]);

    return { maintainers: result.rows };
  });

  // Add maintainer
  app.post('/gitswarm/repos/:id/maintainers', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['maintainer'] } // Only owner can be set at creation
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { agent_id, role = 'maintainer' } = request.body;

    // Check if agent is owner
    const isOwner = await permissionService.isOwner(request.agent.id, id);
    if (!isOwner) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository owners can add maintainers'
      });
    }

    // Check agent exists
    const agent = await query('SELECT id, name FROM agents WHERE id = $1', [agent_id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found'
      });
    }

    await query(`
      INSERT INTO gitswarm_maintainers (repo_id, agent_id, role, added_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (repo_id, agent_id) DO UPDATE SET role = $3
    `, [id, agent_id, role, request.agent.id]);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_maintainer_added',
        target_type: 'gitswarm_repo',
        target_id: id,
        metadata: {
          added_agent_id: agent_id,
          added_agent_name: agent.rows[0].name,
          role
        }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    return { success: true, message: 'Maintainer added' };
  });

  // Remove maintainer
  app.delete('/gitswarm/repos/:id/maintainers/:agent_id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id, agent_id } = request.params;

    // Check if agent is owner
    const isOwner = await permissionService.isOwner(request.agent.id, id);
    if (!isOwner) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository owners can remove maintainers'
      });
    }

    // Check we're not removing the last owner
    const maintainer = await query(`
      SELECT role FROM gitswarm_maintainers WHERE repo_id = $1 AND agent_id = $2
    `, [id, agent_id]);

    if (maintainer.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Maintainer not found'
      });
    }

    if (maintainer.rows[0].role === 'owner') {
      const ownerCount = await query(`
        SELECT COUNT(*) as count FROM gitswarm_maintainers
        WHERE repo_id = $1 AND role = 'owner'
      `, [id]);

      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Cannot remove the last owner'
        });
      }
    }

    await query(`
      DELETE FROM gitswarm_maintainers
      WHERE repo_id = $1 AND agent_id = $2
    `, [id, agent_id]);

    return { success: true, message: 'Maintainer removed' };
  });

  // ============================================================
  // Access Control Routes
  // ============================================================

  // List access grants
  app.get('/gitswarm/repos/:id/access', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check if agent has admin access
    const canView = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canView.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can view access grants'
      });
    }

    const result = await query(`
      SELECT
        a.id as agent_id, a.name, a.avatar_url,
        ra.access_level, ra.granted_at, ra.expires_at, ra.reason,
        g.name as granted_by_name
      FROM gitswarm_repo_access ra
      JOIN agents a ON ra.agent_id = a.id
      LEFT JOIN agents g ON ra.granted_by = g.id
      WHERE ra.repo_id = $1
      ORDER BY ra.granted_at DESC
    `, [id]);

    return { access: result.rows };
  });

  // Grant access
  app.post('/gitswarm/repos/:id/access', {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['agent_id', 'access_level'],
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
          access_level: { type: 'string', enum: ['read', 'write', 'maintain', 'admin'] },
          reason: { type: 'string', maxLength: 500 },
          expires_at: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { agent_id, access_level, reason, expires_at } = request.body;

    // Check if agent is admin
    const canGrant = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canGrant.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can grant access'
      });
    }

    // Check agent exists
    const agent = await query('SELECT id, name FROM agents WHERE id = $1', [agent_id]);
    if (agent.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found'
      });
    }

    await query(`
      INSERT INTO gitswarm_repo_access (repo_id, agent_id, access_level, granted_by, reason, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (repo_id, agent_id) DO UPDATE SET
        access_level = $3, granted_by = $4, reason = $5, expires_at = $6, granted_at = NOW()
    `, [id, agent_id, access_level, request.agent.id, reason, expires_at]);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_access_granted',
        target_type: 'gitswarm_repo',
        target_id: id,
        metadata: {
          granted_agent_id: agent_id,
          granted_agent_name: agent.rows[0].name,
          access_level
        }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({
      access: {
        agent: { id: agent_id, name: agent.rows[0].name },
        access_level,
        granted_by: { id: request.agent.id, name: request.agent.name },
        granted_at: new Date().toISOString()
      }
    });
  });

  // Revoke access
  app.delete('/gitswarm/repos/:id/access/:agent_id', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id, agent_id } = request.params;

    // Check if agent is admin
    const canRevoke = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canRevoke.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can revoke access'
      });
    }

    const result = await query(`
      DELETE FROM gitswarm_repo_access
      WHERE repo_id = $1 AND agent_id = $2
      RETURNING agent_id
    `, [id, agent_id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Access grant not found'
      });
    }

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_access_revoked',
        target_type: 'gitswarm_repo',
        target_id: id,
        metadata: { revoked_agent_id: agent_id }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    return { success: true, message: 'Access revoked' };
  });

  // ============================================================
  // Content Read Routes
  // ============================================================

  // Get file contents
  app.get('/gitswarm/repos/:id/contents/*', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id } = request.params;
    const path = request.params['*'] || '';
    const ref = request.query.ref;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    try {
      const contents = await gitswarmService.getFileContents(id, path, ref);
      return { contents };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({
          error: 'Not Found',
          message: error.message
        });
      }
      throw error;
    }
  });

  // Get directory listing
  app.get('/gitswarm/repos/:id/tree', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id } = request.params;
    const ref = request.query.ref;
    const recursive = request.query.recursive !== 'false';

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    try {
      const tree = await gitswarmService.getTree(id, ref, recursive);
      return { tree };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({
          error: 'Not Found',
          message: error.message
        });
      }
      throw error;
    }
  });

  // Get branches
  app.get('/gitswarm/repos/:id/branches', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    try {
      const branches = await gitswarmService.getBranches(id);
      return { branches };
    } catch (error) {
      throw error;
    }
  });

  // Get commits
  app.get('/gitswarm/repos/:id/commits', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id } = request.params;
    const { sha, path, since, until, per_page } = request.query;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    try {
      const commits = await gitswarmService.getCommits(id, {
        sha,
        path,
        since,
        until,
        per_page: per_page ? parseInt(per_page) : 30
      });
      return { commits };
    } catch (error) {
      throw error;
    }
  });

  // Get pull requests
  app.get('/gitswarm/repos/:id/pulls', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id } = request.params;
    const { state, sort, direction, per_page } = request.query;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    try {
      const pulls = await gitswarmService.getPullRequests(id, {
        state,
        sort,
        direction,
        per_page: per_page ? parseInt(per_page) : 30
      });
      return { pulls };
    } catch (error) {
      throw error;
    }
  });

  // Get clone access (returns authenticated clone URL)
  app.get('/gitswarm/repos/:id/clone', {
    preHandler: [authenticate, rateLimitClone],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check write access for clone with token
    const canWrite = await permissionService.canPerform(request.agent.id, id, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      const { repo, cloneUrl } = await gitswarmService.getRepoWithCloneAccess(id);
      return {
        clone_url: cloneUrl,
        repo: {
          github_full_name: repo.github_full_name,
          default_branch: repo.default_branch
        }
      };
    } catch (error) {
      throw error;
    }
  });

  // ============================================================
  // Branch Rules Routes
  // ============================================================

  // List branch rules
  app.get('/gitswarm/repos/:id/branch-rules', {
    preHandler: [authenticate, rateLimit],
  }, async (request, reply) => {
    const { id } = request.params;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    const result = await query(`
      SELECT id, branch_pattern, direct_push, required_approvals, require_tests_pass,
             require_up_to_date, consensus_threshold, merge_restriction, priority,
             created_at, updated_at
      FROM gitswarm_branch_rules
      WHERE repo_id = $1
      ORDER BY priority DESC, LENGTH(branch_pattern) DESC
    `, [id]);

    return { branch_rules: result.rows };
  });

  // Create branch rule
  app.post('/gitswarm/repos/:id/branch-rules', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['branch_pattern'],
        properties: {
          branch_pattern: { type: 'string', minLength: 1, maxLength: 255 },
          direct_push: { type: 'string', enum: ['none', 'maintainers', 'all'] },
          required_approvals: { type: 'integer', minimum: 0 },
          require_tests_pass: { type: 'boolean' },
          require_up_to_date: { type: 'boolean' },
          consensus_threshold: { type: 'number', minimum: 0, maximum: 1 },
          merge_restriction: { type: 'string', enum: ['none', 'maintainers', 'consensus'] },
          priority: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const {
      branch_pattern,
      direct_push = 'none',
      required_approvals = 1,
      require_tests_pass = true,
      require_up_to_date = false,
      consensus_threshold,
      merge_restriction = 'consensus',
      priority = 0
    } = request.body;

    // Check admin access
    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can create branch rules'
      });
    }

    try {
      const result = await query(`
        INSERT INTO gitswarm_branch_rules (
          repo_id, branch_pattern, direct_push, required_approvals,
          require_tests_pass, require_up_to_date, consensus_threshold,
          merge_restriction, priority
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        id, branch_pattern, direct_push, required_approvals,
        require_tests_pass, require_up_to_date, consensus_threshold,
        merge_restriction, priority
      ]);

      reply.status(201).send({ branch_rule: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') { // Unique violation
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A branch rule for this pattern already exists'
        });
      }
      throw error;
    }
  });

  // Update branch rule
  app.patch('/gitswarm/repos/:id/branch-rules/:ruleId', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          direct_push: { type: 'string', enum: ['none', 'maintainers', 'all'] },
          required_approvals: { type: 'integer', minimum: 0 },
          require_tests_pass: { type: 'boolean' },
          require_up_to_date: { type: 'boolean' },
          consensus_threshold: { type: 'number', minimum: 0, maximum: 1 },
          merge_restriction: { type: 'string', enum: ['none', 'maintainers', 'consensus'] },
          priority: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id, ruleId } = request.params;

    // Check admin access
    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can update branch rules'
      });
    }

    const allowedFields = [
      'direct_push', 'required_approvals', 'require_tests_pass',
      'require_up_to_date', 'consensus_threshold', 'merge_restriction', 'priority'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex++}`);
        values.push(request.body[field]);
      }
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No updates provided'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(ruleId, id);

    const result = await query(`
      UPDATE gitswarm_branch_rules SET ${updates.join(', ')}
      WHERE id = $${paramIndex} AND repo_id = $${paramIndex + 1}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Branch rule not found'
      });
    }

    return { branch_rule: result.rows[0] };
  });

  // Delete branch rule
  app.delete('/gitswarm/repos/:id/branch-rules/:ruleId', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { id, ruleId } = request.params;

    // Check admin access
    const canAdmin = await permissionService.canPerform(request.agent.id, id, 'settings');
    if (!canAdmin.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only repository admins can delete branch rules'
      });
    }

    const result = await query(`
      DELETE FROM gitswarm_branch_rules
      WHERE id = $1 AND repo_id = $2
      RETURNING id
    `, [ruleId, id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Branch rule not found'
      });
    }

    return { success: true, message: 'Branch rule deleted' };
  });

  // ============================================================
  // Write Operations Routes
  // ============================================================

  // Create file
  app.post('/gitswarm/repos/:id/contents/*', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['content', 'message'],
        properties: {
          content: { type: 'string' },
          message: { type: 'string', minLength: 1, maxLength: 1000 },
          branch: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const path = request.params['*'] || '';
    const { content, message, branch } = request.body;

    if (!path) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'File path is required'
      });
    }

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, id, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    // Check branch push permission if branch specified
    if (branch) {
      const canPush = await permissionService.canPushToBranch(request.agent.id, id, branch);
      if (!canPush.allowed) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Cannot push to branch: ${canPush.reason}`
        });
      }
    }

    try {
      const result = await gitswarmService.createFile(
        id,
        path,
        content,
        message,
        branch,
        request.agent.name,
        `${request.agent.id}@bothub.agent`
      );

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_file_created',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: { path, branch: branch || 'default' }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ result });
    } catch (error) {
      if (error.message.includes('422')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'File already exists. Use PUT to update.'
        });
      }
      throw error;
    }
  });

  // Update file
  app.put('/gitswarm/repos/:id/contents/*', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['content', 'message', 'sha'],
        properties: {
          content: { type: 'string' },
          message: { type: 'string', minLength: 1, maxLength: 1000 },
          sha: { type: 'string', minLength: 1 },
          branch: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const path = request.params['*'] || '';
    const { content, message, sha, branch } = request.body;

    if (!path) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'File path is required'
      });
    }

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, id, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    // Check branch push permission
    if (branch) {
      const canPush = await permissionService.canPushToBranch(request.agent.id, id, branch);
      if (!canPush.allowed) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Cannot push to branch: ${canPush.reason}`
        });
      }
    }

    try {
      const result = await gitswarmService.updateFile(
        id,
        path,
        content,
        message,
        sha,
        branch,
        request.agent.name,
        `${request.agent.id}@bothub.agent`
      );

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_file_updated',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: { path, branch: branch || 'default' }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return { result };
    } catch (error) {
      if (error.message.includes('409')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'File has been modified. Please fetch the latest SHA.'
        });
      }
      throw error;
    }
  });

  // Create branch
  app.post('/gitswarm/repos/:id/branches', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'sha'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          sha: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, sha } = request.body;

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, id, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      const result = await gitswarmService.createBranch(id, name, sha);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_branch_created',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: { branch: name }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({ branch: { name, sha, ref: result.ref } });
    } catch (error) {
      if (error.message.includes('422')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Branch already exists'
        });
      }
      throw error;
    }
  });

  // ============================================================
  // Pull Request Routes
  // ============================================================

  // Create pull request
  app.post('/gitswarm/repos/:id/pulls', {
    preHandler: [authenticate, rateLimitPR],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'head'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          body: { type: 'string', maxLength: 10000 },
          head: { type: 'string', minLength: 1 },
          base: { type: 'string' },
          draft: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const prData = request.body;

    // Check write access
    const canWrite = await permissionService.canPerform(request.agent.id, id, 'write');
    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      const result = await gitswarmService.createPullRequest(id, prData);

      // Create GitSwarm patch record
      await query(`
        INSERT INTO gitswarm_patches (
          patch_id, repo_id, github_pr_number, github_pr_url, github_branch, base_branch
        )
        SELECT
          p.id, $2, $3, $4, $5, $6
        FROM patches p
        WHERE p.github_pr_url = $4
        ON CONFLICT (patch_id) DO UPDATE SET
          github_pr_number = $3,
          github_pr_url = $4,
          github_branch = $5,
          base_branch = $6,
          last_synced_at = NOW()
      `, [id, id, result.number, result.html_url, prData.head, prData.base || 'main']);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_pr_created',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: {
            pr_number: result.number,
            title: prData.title,
            head: prData.head,
            base: prData.base || 'main'
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({
        pull_request: {
          number: result.number,
          url: result.html_url,
          title: prData.title,
          head: prData.head,
          base: prData.base
        }
      });
    } catch (error) {
      if (error.message.includes('422')) {
        return reply.status(422).send({
          error: 'Unprocessable Entity',
          message: 'Unable to create PR. Branch may not exist or PR already exists.'
        });
      }
      throw error;
    }
  });

  // Check merge eligibility
  app.get('/gitswarm/repos/:id/pulls/:prNumber/merge-check', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id, prNumber } = request.params;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    // Get the patch associated with this PR
    const patchResult = await query(`
      SELECT gp.patch_id, gp.base_branch, p.id as patch_id
      FROM gitswarm_patches gp
      JOIN patches p ON gp.patch_id = p.id
      WHERE gp.repo_id = $1 AND gp.github_pr_number = $2
    `, [id, prNumber]);

    if (patchResult.rows.length === 0) {
      // PR not tracked in GitSwarm, check permissions directly
      const canMerge = await permissionService.canPerform(request.agent.id, id, 'merge');
      return {
        eligible: canMerge.allowed,
        reason: canMerge.allowed ? 'has_merge_permission' : 'no_merge_permission',
        checks: {
          has_permission: canMerge.allowed,
          consensus: { reached: false, reason: 'not_tracked' }
        }
      };
    }

    const patch = patchResult.rows[0];

    // Check consensus
    const consensus = await permissionService.checkConsensus(patch.patch_id, id);

    // Check branch rules
    const baseBranch = patch.base_branch || 'main';
    const testsRequired = await permissionService.requiresTestsPass(id, baseBranch);
    const requiredApprovals = await permissionService.getRequiredApprovals(id, baseBranch);

    // Determine eligibility
    const canMerge = await permissionService.canPerform(request.agent.id, id, 'merge');
    const eligible = consensus.reached && canMerge.allowed;

    return {
      eligible,
      reason: eligible ? 'all_checks_passed' : (consensus.reached ? 'no_merge_permission' : 'consensus_not_reached'),
      checks: {
        has_permission: canMerge.allowed,
        consensus,
        branch_rules: {
          tests_required: testsRequired,
          required_approvals: requiredApprovals
        }
      }
    };
  });

  // Merge pull request
  app.put('/gitswarm/repos/:id/pulls/:prNumber/merge', {
    preHandler: [authenticate, rateLimitPR],
    schema: {
      body: {
        type: 'object',
        properties: {
          merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
          commit_title: { type: 'string', maxLength: 255 },
          commit_message: { type: 'string', maxLength: 10000 }
        }
      }
    }
  }, async (request, reply) => {
    const { id, prNumber } = request.params;
    const { merge_method = 'squash', commit_title, commit_message } = request.body || {};

    // Check merge permission
    const canMerge = await permissionService.canPerform(request.agent.id, id, 'merge');
    if (!canMerge.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have merge permission on this repository'
      });
    }

    // Get patch and check consensus
    const patchResult = await query(`
      SELECT gp.patch_id, gp.base_branch
      FROM gitswarm_patches gp
      JOIN patches p ON gp.patch_id = p.id
      WHERE gp.repo_id = $1 AND gp.github_pr_number = $2
    `, [id, prNumber]);

    if (patchResult.rows.length > 0) {
      const consensus = await permissionService.checkConsensus(
        patchResult.rows[0].patch_id,
        id
      );

      if (!consensus.reached) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Consensus not reached for this pull request',
          consensus
        });
      }
    }

    try {
      const result = await gitswarmService.mergePullRequest(id, parseInt(prNumber), {
        merge_method,
        commit_title,
        commit_message
      });

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_pr_merged',
          target_type: 'gitswarm_repo',
          target_id: id,
          metadata: { pr_number: prNumber, merge_method }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return {
        merged: true,
        sha: result.sha,
        message: result.message
      };
    } catch (error) {
      if (error.message.includes('405')) {
        return reply.status(405).send({
          error: 'Method Not Allowed',
          message: 'Pull request is not mergeable'
        });
      }
      if (error.message.includes('409')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Head branch was modified. Review and update required.'
        });
      }
      throw error;
    }
  });

  // ============================================================
  // Patch Review Routes (for consensus system)
  // ============================================================

  // Submit review for a patch/PR
  app.post('/gitswarm/repos/:id/pulls/:prNumber/reviews', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
          body: { type: 'string', maxLength: 10000 },
          tested: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id, prNumber } = request.params;
    const { verdict, body, tested = false } = request.body;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    // Get the patch
    const patchResult = await query(`
      SELECT gp.patch_id
      FROM gitswarm_patches gp
      WHERE gp.repo_id = $1 AND gp.github_pr_number = $2
    `, [id, prNumber]);

    if (patchResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Pull request not tracked in GitSwarm'
      });
    }

    const patchId = patchResult.rows[0].patch_id;

    // Insert or update review
    await query(`
      INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, tested)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET
        verdict = $3,
        feedback = $4,
        tested = $5,
        reviewed_at = NOW()
    `, [patchId, request.agent.id, verdict, body, tested]);

    // Update reviewer stats
    await query(`
      INSERT INTO reviewer_stats (agent_id, total_reviews, approvals, rejections)
      VALUES ($1, 1, $2, $3)
      ON CONFLICT (agent_id) DO UPDATE SET
        total_reviews = reviewer_stats.total_reviews + 1,
        approvals = reviewer_stats.approvals + $2,
        rejections = reviewer_stats.rejections + $3,
        updated_at = NOW()
    `, [
      request.agent.id,
      verdict === 'approve' ? 1 : 0,
      verdict === 'request_changes' ? 1 : 0
    ]);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_review_submitted',
        target_type: 'gitswarm_repo',
        target_id: id,
        metadata: { pr_number: prNumber, verdict, tested }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    // Get updated consensus status
    const consensus = await permissionService.checkConsensus(patchId, id);

    reply.status(201).send({
      review: {
        verdict,
        tested,
        reviewer: { id: request.agent.id, name: request.agent.name }
      },
      consensus
    });
  });

  // Get reviews for a PR
  app.get('/gitswarm/repos/:id/pulls/:prNumber/reviews', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { id, prNumber } = request.params;

    // Check read access
    const canRead = await permissionService.canPerform(request.agent.id, id, 'read');
    if (!canRead.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this repository'
      });
    }

    // Get the patch
    const patchResult = await query(`
      SELECT gp.patch_id
      FROM gitswarm_patches gp
      WHERE gp.repo_id = $1 AND gp.github_pr_number = $2
    `, [id, prNumber]);

    if (patchResult.rows.length === 0) {
      return { reviews: [], consensus: null };
    }

    const patchId = patchResult.rows[0].patch_id;

    // Get reviews
    const reviews = await query(`
      SELECT
        pr.verdict, pr.feedback, pr.tested, pr.reviewed_at,
        a.id as reviewer_id, a.name as reviewer_name, a.karma as reviewer_karma,
        CASE WHEN m.agent_id IS NOT NULL THEN true ELSE false END as is_maintainer
      FROM patch_reviews pr
      JOIN agents a ON pr.reviewer_id = a.id
      LEFT JOIN gitswarm_maintainers m ON m.repo_id = $2 AND m.agent_id = pr.reviewer_id
      WHERE pr.patch_id = $1
      ORDER BY pr.reviewed_at DESC
    `, [patchId, id]);

    // Get consensus status
    const consensus = await permissionService.checkConsensus(patchId, id);

    return {
      reviews: reviews.rows.map(r => ({
        verdict: r.verdict,
        feedback: r.feedback,
        tested: r.tested,
        reviewed_at: r.reviewed_at,
        reviewer: {
          id: r.reviewer_id,
          name: r.reviewer_name,
          karma: r.reviewer_karma,
          is_maintainer: r.is_maintainer
        }
      })),
      consensus
    };
  });
}
