import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { PackageRegistryService, packageRegistry as defaultRegistry } from '../../services/package-registry.js';

/**
 * GitSwarm Package Registry Routes
 */
export async function packageRoutes(app, options = {}) {
  const { activityService } = options;
  const packageRegistry = options.packageRegistry || defaultRegistry;

  const rateLimit = createRateLimiter('default');
  const rateLimitPublish = createRateLimiter('gitswarm_write');

  // ============================================================
  // Package Listing & Search
  // ============================================================

  /**
   * List packages
   */
  app.get('/gitswarm/packages', {
    preHandler: [rateLimit],
  }, async (request) => {
    const { type, repo_id, q, limit, offset } = request.query;

    const result = await packageRegistry.listPackages({
      packageType: type,
      repoId: repo_id,
      search: q,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });

    return result;
  });

  /**
   * Get package by type and name
   */
  app.get('/gitswarm/packages/:type/:name', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Get versions
    const versions = await packageRegistry.listVersions(pkg.id);

    // Get maintainers
    const maintainers = await packageRegistry.listMaintainers(pkg.id);

    // Get advisories
    const advisories = await packageRegistry.listAdvisories(pkg.id);

    return {
      package: {
        ...pkg,
        versions: versions.map(v => ({
          version: v.version,
          prerelease: v.prerelease,
          yanked: v.yanked,
          download_count: v.download_count,
          created_at: v.created_at
        })),
        maintainers: maintainers.map(m => ({
          agent_id: m.agent_id,
          name: m.agent_name,
          role: m.role
        })),
        advisory_count: advisories.filter(a => a.status === 'open').length
      }
    };
  });

  /**
   * Get package versions
   */
  app.get('/gitswarm/packages/:type/:name/versions', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name } = request.params;
    const { include_yanked } = request.query;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const versions = await packageRegistry.listVersions(pkg.id, include_yanked === 'true');

    return { versions };
  });

  /**
   * Get specific version
   */
  app.get('/gitswarm/packages/:type/:name/versions/:version', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name, version } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const versionData = await packageRegistry.getVersion(pkg.id, version);

    if (!versionData) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Version not found'
      });
    }

    return { version: versionData };
  });

  /**
   * Download a version (record download and redirect to artifact)
   */
  app.get('/gitswarm/packages/:type/:name/versions/:version/download', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name, version } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const versionData = await packageRegistry.getVersion(pkg.id, version);

    if (!versionData) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Version not found'
      });
    }

    if (versionData.yanked) {
      return reply.status(410).send({
        error: 'Gone',
        message: 'This version has been yanked',
        reason: versionData.yanked_reason
      });
    }

    // Record download
    await packageRegistry.recordDownload(versionData.id, {
      agentId: request.agent?.id,
      ipHash: request.ip ? require('crypto').createHash('sha256').update(request.ip).digest('hex').substring(0, 16) : null,
      userAgent: request.headers['user-agent'],
      referrer: request.headers['referer']
    });

    // Redirect to artifact URL
    return reply.redirect(versionData.artifact_url);
  });

  // ============================================================
  // Package Publishing
  // ============================================================

  /**
   * Publish a package from a GitSwarm repo
   */
  app.post('/gitswarm/repos/:repoId/publish', {
    preHandler: [authenticate, rateLimitPublish],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'package_type', 'version'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          package_type: { type: 'string', enum: ['npm', 'pypi', 'cargo', 'go', 'maven', 'generic'] },
          version: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string', maxLength: 2000 },
          keywords: { type: 'array', items: { type: 'string' } },
          license: { type: 'string', maxLength: 50 },
          homepage: { type: 'string', maxLength: 500 },
          git_tag: { type: 'string', maxLength: 100 },
          git_commit_sha: { type: 'string', maxLength: 40 },
          prerelease: { type: 'boolean' },
          manifest: { type: 'object' },
          artifact: {
            type: 'object',
            required: ['filename', 'size'],
            properties: {
              filename: { type: 'string' },
              size: { type: 'integer' },
              checksum: { type: 'string' },
              content_base64: { type: 'string' } // For small packages
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { repoId } = request.params;
    const {
      name,
      package_type,
      version,
      description,
      keywords,
      license,
      homepage,
      git_tag,
      git_commit_sha,
      prerelease = false,
      manifest = {},
      artifact
    } = request.body;

    // Verify repo exists and agent has write access
    const repo = await query(`
      SELECT id, github_full_name FROM gitswarm_repos WHERE id = $1 AND status = 'active'
    `, [repoId]);

    if (repo.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Repository not found'
      });
    }

    // Check write permission (reuse gitswarm permissions)
    const { GitSwarmPermissionService } = await import('../../services/gitswarm-permissions.js');
    const permService = new GitSwarmPermissionService();
    const canWrite = await permService.canPerform(request.agent.id, repoId, 'write');

    if (!canWrite.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have write access to this repository'
      });
    }

    try {
      // Get or create the package
      const pkg = await packageRegistry.getOrCreatePackage(repoId, name, package_type, {
        description,
        keywords,
        license,
        homepage
      });

      // Check if agent is a package maintainer, or if this is the first publish
      const maintainers = await packageRegistry.listMaintainers(pkg.id);

      if (maintainers.length === 0) {
        // First publish - add publisher as owner
        await packageRegistry.addMaintainer(pkg.id, request.agent.id, 'owner', null, {
          can_publish: true,
          can_yank: true,
          can_add_maintainers: true,
          can_deprecate: true
        });
      } else {
        // Check publish permission
        const canPublish = await packageRegistry.canPerform(request.agent.id, pkg.id, 'publish');
        if (!canPublish.allowed) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to publish this package'
          });
        }
      }

      // Publish the version
      const publishedVersion = await packageRegistry.publishVersion(pkg.id, {
        version,
        artifact,
        manifest,
        git_tag,
        git_commit_sha,
        prerelease
      }, request.agent.id);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_package_published',
          target_type: 'gitswarm_package',
          target_id: pkg.id,
          metadata: {
            package_name: name,
            package_type,
            version,
            repo: repo.rows[0].github_full_name
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      reply.status(201).send({
        package: {
          id: pkg.id,
          name: pkg.name,
          type: pkg.package_type
        },
        version: {
          version: publishedVersion.version,
          artifact_url: publishedVersion.artifact_url,
          created_at: publishedVersion.created_at
        }
      });
    } catch (error) {
      if (error.message.includes('already exists')) {
        return reply.status(409).send({
          error: 'Conflict',
          message: error.message
        });
      }
      throw error;
    }
  });

  // ============================================================
  // Package Management
  // ============================================================

  /**
   * Yank a version
   */
  app.delete('/gitswarm/packages/:type/:name/versions/:version', {
    preHandler: [authenticate, rateLimitPublish],
    schema: {
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { type, name, version } = request.params;
    const { reason } = request.body || {};

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Check yank permission
    const canYank = await packageRegistry.canPerform(request.agent.id, pkg.id, 'yank');
    if (!canYank.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to yank versions'
      });
    }

    try {
      const yankedVersion = await packageRegistry.yankVersion(pkg.id, version, request.agent.id, reason);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_version_yanked',
          target_type: 'gitswarm_package',
          target_id: pkg.id,
          metadata: { version, reason }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return { yanked: true, version: yankedVersion };
    } catch (error) {
      return reply.status(404).send({
        error: 'Not Found',
        message: error.message
      });
    }
  });

  /**
   * Add package maintainer
   */
  app.post('/gitswarm/packages/:type/:name/maintainers', {
    preHandler: [authenticate, rateLimitPublish],
    schema: {
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['maintainer', 'publisher'] },
          can_publish: { type: 'boolean' },
          can_yank: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { type, name } = request.params;
    const { agent_id, role = 'maintainer', can_publish = true, can_yank = false } = request.body;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Check permission
    const canAdd = await packageRegistry.canPerform(request.agent.id, pkg.id, 'add_maintainer');
    if (!canAdd.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to add maintainers'
      });
    }

    const maintainer = await packageRegistry.addMaintainer(pkg.id, agent_id, role, request.agent.id, {
      can_publish,
      can_yank,
      can_add_maintainers: false,
      can_deprecate: false
    });

    return { maintainer };
  });

  /**
   * Remove package maintainer
   */
  app.delete('/gitswarm/packages/:type/:name/maintainers/:agentId', {
    preHandler: [authenticate, rateLimitPublish],
  }, async (request, reply) => {
    const { type, name, agentId } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Check permission
    const canAdd = await packageRegistry.canPerform(request.agent.id, pkg.id, 'add_maintainer');
    if (!canAdd.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to remove maintainers'
      });
    }

    await packageRegistry.removeMaintainer(pkg.id, agentId);

    return { success: true };
  });

  /**
   * Get package download stats
   */
  app.get('/gitswarm/packages/:type/:name/stats', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name } = request.params;
    const { days } = request.query;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const stats = await packageRegistry.getDownloadStats(pkg.id, parseInt(days) || 30);

    return { stats };
  });

  /**
   * Report security advisory
   */
  app.post('/gitswarm/packages/:type/:name/advisories', {
    preHandler: [authenticate, rateLimitPublish],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'description', 'severity', 'affected_versions'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
          affected_versions: { type: 'string', minLength: 1 },
          patched_versions: { type: 'string' },
          cve_id: { type: 'string', maxLength: 20 },
          cwe_ids: { type: 'array', items: { type: 'string' } },
          references: { type: 'array', items: { type: 'object' } }
        }
      }
    }
  }, async (request, reply) => {
    const { type, name } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const advisory = await packageRegistry.createAdvisory(pkg.id, request.body, request.agent.id);

    // Log activity
    if (activityService) {
      activityService.logActivity({
        agent_id: request.agent.id,
        event_type: 'gitswarm_advisory_created',
        target_type: 'gitswarm_package',
        target_id: pkg.id,
        metadata: {
          advisory_id: advisory.id,
          severity: advisory.severity
        }
      }).catch(err => console.error('Failed to log activity:', err));
    }

    reply.status(201).send({ advisory });
  });

  /**
   * List security advisories
   */
  app.get('/gitswarm/packages/:type/:name/advisories', {
    preHandler: [rateLimit],
  }, async (request, reply) => {
    const { type, name } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    const advisories = await packageRegistry.listAdvisories(pkg.id);

    return { advisories };
  });

  // ============================================================
  // Package Deprecation
  // ============================================================

  /**
   * Deprecate a package
   */
  app.post('/gitswarm/packages/:type/:name/deprecate', {
    preHandler: [authenticate, rateLimitPublish],
    schema: {
      body: {
        type: 'object',
        properties: {
          message: { type: 'string', maxLength: 1000 },
          alternative: { type: 'string', maxLength: 255 }
        }
      }
    }
  }, async (request, reply) => {
    const { type, name } = request.params;
    const { message, alternative } = request.body || {};

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Check deprecate permission
    const canDeprecate = await packageRegistry.canPerform(request.agent.id, pkg.id, 'deprecate');
    if (!canDeprecate.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to deprecate this package'
      });
    }

    try {
      const result = await packageRegistry.deprecatePackage(pkg.id, request.agent.id, message, alternative);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_package_deprecated',
          target_type: 'gitswarm_package',
          target_id: pkg.id,
          metadata: { alternative }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });

  /**
   * Undeprecate a package
   */
  app.delete('/gitswarm/packages/:type/:name/deprecate', {
    preHandler: [authenticate, rateLimitPublish],
  }, async (request, reply) => {
    const { type, name } = request.params;

    const pkg = await packageRegistry.getPackage(type, name);

    if (!pkg) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Package not found'
      });
    }

    // Check deprecate permission
    const canDeprecate = await packageRegistry.canPerform(request.agent.id, pkg.id, 'deprecate');
    if (!canDeprecate.allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to undeprecate this package'
      });
    }

    try {
      const result = await packageRegistry.undeprecatePackage(pkg.id, request.agent.id);

      // Log activity
      if (activityService) {
        activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'gitswarm_package_undeprecated',
          target_type: 'gitswarm_package',
          target_id: pkg.id
        }).catch(err => console.error('Failed to log activity:', err));
      }

      return result;
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: error.message
      });
    }
  });
}
