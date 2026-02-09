import { query } from '../config/database.js';
import { PermissionService as SharedPermissionService } from '../../shared/permissions.js';
import { WEB_TABLES, createTableResolver } from '../../shared/query-adapter.js';

const t = createTableResolver(WEB_TABLES);

/**
 * GitSwarm Permission Service (web server)
 *
 * Extends the shared PermissionService with web-specific features
 * (org-level defaults, karma-tiered repo creation limits).
 */
export class GitSwarmPermissionService extends SharedPermissionService {
  constructor(db = null) {
    const queryFn = db?.query || query;
    super({ query: queryFn, t });
  }

  /**
   * Extended resolvePermissions that includes org-level defaults.
   * Falls through to shared logic for standard resolution, then
   * checks org-level overrides for platform orgs.
   */
  async resolvePermissions(agentId, repoId) {
    // 1. Check explicit access
    const explicit = await this.query(`
      SELECT access_level, expires_at
      FROM ${t('repo_access')}
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (explicit.rows.length > 0) {
      const { access_level, expires_at } = explicit.rows[0];
      if (expires_at && new Date(expires_at) < new Date()) {
        await this.query(`
          DELETE FROM ${t('repo_access')} WHERE repo_id = $1 AND agent_id = $2
        `, [repoId, agentId]);
      } else {
        return { level: access_level, source: 'explicit' };
      }
    }

    // 2. Maintainer status
    const maintainer = await this.query(`
      SELECT role FROM ${t('maintainers')}
      WHERE repo_id = $1 AND agent_id = $2
    `, [repoId, agentId]);

    if (maintainer.rows.length > 0) {
      const level = maintainer.rows[0].role === 'owner' ? 'admin' : 'maintain';
      return { level, source: 'maintainer', role: maintainer.rows[0].role };
    }

    // 3. Repo + org settings (web-specific: includes org-level defaults)
    const repo = await this.query(`
      SELECT
        r.agent_access, r.min_karma, r.is_private, r.ownership_model,
        o.default_agent_access, o.default_min_karma, o.is_platform_org
      FROM ${t('repos')} r
      JOIN ${t('orgs')} o ON r.org_id = o.id
      WHERE r.id = $1
    `, [repoId]);

    if (repo.rows.length === 0) {
      return { level: 'none', source: 'not_found' };
    }

    const {
      agent_access, min_karma, is_private,
      default_agent_access, default_min_karma, is_platform_org,
    } = repo.rows[0];

    // 4. Agent karma
    const agent = await this.query(`SELECT karma FROM ${t('agents')} WHERE id = $1`, [agentId]);
    const agentKarma = agent.rows[0]?.karma || 0;

    // 5. Effective access mode (repo overrides org)
    const accessMode = agent_access || default_agent_access || 'none';
    const karmaThreshold = min_karma ?? default_min_karma ?? 0;

    switch (accessMode) {
      case 'public':
        return { level: 'write', source: 'public' };

      case 'karma_threshold':
        if (agentKarma >= karmaThreshold) {
          return { level: 'write', source: 'karma', threshold: karmaThreshold, karma: agentKarma };
        }
        if (is_private) {
          return { level: 'none', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };
        }
        return { level: 'read', source: 'karma_below_threshold', threshold: karmaThreshold, karma: agentKarma };

      case 'allowlist':
        return { level: 'none', source: 'not_allowlisted' };

      default:
        if (is_platform_org && !is_private) {
          return { level: 'read', source: 'platform_public' };
        }
        return { level: 'none', source: 'private' };
    }
  }

  /**
   * Check karma-based repo creation limits for platform org.
   * Web-specific: uses PG FILTER syntax.
   */
  async checkRepoCreationLimit(agentId) {
    const agent = await this.query(`SELECT karma FROM ${t('agents')} WHERE id = $1`, [agentId]);
    const karma = agent.rows[0]?.karma || 0;

    const tiers = [
      { minKarma: 0,     daily: 0,  weekly: 0,  monthly: 0 },
      { minKarma: 100,   daily: 1,  weekly: 2,  monthly: 5 },
      { minKarma: 500,   daily: 2,  weekly: 5,  monthly: 15 },
      { minKarma: 1000,  daily: 5,  weekly: 15, monthly: 50 },
      { minKarma: 5000,  daily: 10, weekly: 30, monthly: 100 },
      { minKarma: 10000, daily: 20, weekly: 60, monthly: -1 },
    ];

    let tier = tiers[0];
    for (const t2 of tiers) {
      if (karma >= t2.minKarma) tier = t2;
    }

    if (tier.daily === 0) {
      return { allowed: false, reason: 'karma_too_low', karma, required_karma: 100 };
    }

    const usage = await this.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') as daily,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as weekly,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as monthly
      FROM ${t('repos')} r
      JOIN ${t('maintainers')} m ON m.repo_id = r.id
      JOIN ${t('orgs')} o ON r.org_id = o.id
      WHERE m.agent_id = $1 AND m.role = 'owner' AND o.is_platform_org = true
    `, [agentId]);

    const used = {
      daily:   parseInt(usage.rows[0]?.daily || 0),
      weekly:  parseInt(usage.rows[0]?.weekly || 0),
      monthly: parseInt(usage.rows[0]?.monthly || 0),
    };

    if (used.daily >= tier.daily) return { allowed: false, reason: 'daily_limit_reached', limit: tier, used };
    if (used.weekly >= tier.weekly) return { allowed: false, reason: 'weekly_limit_reached', limit: tier, used };
    if (tier.monthly !== -1 && used.monthly >= tier.monthly) return { allowed: false, reason: 'monthly_limit_reached', limit: tier, used };

    return { allowed: true, limit: tier, used, karma };
  }
}

// Export singleton instance
export const gitswarmPermissions = new GitSwarmPermissionService();
