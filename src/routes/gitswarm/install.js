import { query } from '../../config/database.js';
import { githubApp } from '../../services/github.js';

/**
 * GitSwarm Installation Routes
 * Handles OAuth flow for installing BotHub GitHub App on external organizations
 */
export async function installRoutes(app, options = {}) {
  const { activityService } = options;

  // ============================================================
  // OAuth Installation Flow
  // ============================================================

  /**
   * Initiate GitHub App installation
   * Redirects user to GitHub to install the app
   */
  app.get('/gitswarm/install', async (request, reply) => {
    const { state, suggested_target_id } = request.query;

    // Build GitHub App installation URL
    const appSlug = process.env.GITHUB_APP_SLUG || 'bothub';
    let installUrl = `https://github.com/apps/${appSlug}/installations/new`;

    // Add query params if provided
    const params = new URLSearchParams();
    if (state) {
      params.set('state', state);
    }
    if (suggested_target_id) {
      params.set('suggested_target_id', suggested_target_id);
    }

    if (params.toString()) {
      installUrl += `?${params.toString()}`;
    }

    return reply.redirect(installUrl);
  });

  /**
   * Handle GitHub App installation callback
   * Called after user installs/configures the app
   */
  app.get('/gitswarm/callback', async (request, reply) => {
    const { installation_id, setup_action, state } = request.query;

    if (!installation_id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Missing installation_id parameter'
      });
    }

    try {
      // Fetch installation details from GitHub
      const installationDetails = await githubApp.getInstallationDetails(installation_id);

      if (!installationDetails) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Installation not found on GitHub'
        });
      }

      // Create or update the GitSwarm org
      const result = await query(`
        INSERT INTO gitswarm_orgs (
          github_org_name, github_org_id, github_installation_id, status, metadata
        ) VALUES ($1, $2, $3, 'active', $4)
        ON CONFLICT (github_installation_id) DO UPDATE SET
          github_org_name = $1,
          status = 'active',
          metadata = gitswarm_orgs.metadata || $4,
          updated_at = NOW()
        RETURNING id, github_org_name, is_platform_org
      `, [
        installationDetails.account.login,
        installationDetails.account.id,
        installation_id,
        JSON.stringify({
          avatar_url: installationDetails.account.avatar_url,
          html_url: installationDetails.account.html_url,
          account_type: installationDetails.account.type // 'Organization' or 'User'
        })
      ]);

      const org = result.rows[0];

      // Sync repositories from the installation
      const repos = await githubApp.getInstallationRepositories(installation_id);

      if (repos && repos.length > 0) {
        for (const repo of repos) {
          await syncRepository(org.id, repo);
        }
      }

      // Log activity
      if (activityService) {
        activityService.logActivity({
          event_type: 'gitswarm_org_installed',
          target_type: 'gitswarm_org',
          target_id: org.id,
          metadata: {
            org_name: org.github_org_name,
            setup_action,
            repo_count: repos?.length || 0
          }
        }).catch(err => console.error('Failed to log activity:', err));
      }

      // Determine redirect URL
      const successUrl = state
        ? decodeURIComponent(state)
        : `/gitswarm/orgs/${org.id}`;

      // Return success response or redirect
      if (request.query.redirect === 'false') {
        return {
          success: true,
          org: {
            id: org.id,
            github_org_name: org.github_org_name,
            is_platform_org: org.is_platform_org
          },
          repos_synced: repos?.length || 0
        };
      }

      return reply.redirect(successUrl);
    } catch (error) {
      console.error('Installation callback failed:', error);
      return reply.status(500).send({
        error: 'Installation Failed',
        message: 'Failed to complete GitHub App installation'
      });
    }
  });

  /**
   * Get installation status for an organization
   */
  app.get('/gitswarm/install/status/:orgName', async (request, reply) => {
    const { orgName } = request.params;

    const result = await query(`
      SELECT
        id, github_org_name, github_installation_id, status,
        is_platform_org, default_agent_access, default_min_karma,
        created_at, updated_at, metadata
      FROM gitswarm_orgs
      WHERE github_org_name = $1
    `, [orgName]);

    if (result.rows.length === 0) {
      return {
        installed: false,
        org_name: orgName
      };
    }

    const org = result.rows[0];

    // Get repo count
    const repoCount = await query(`
      SELECT COUNT(*) as count FROM gitswarm_repos
      WHERE org_id = $1 AND status = 'active'
    `, [org.id]);

    return {
      installed: true,
      org: {
        id: org.id,
        github_org_name: org.github_org_name,
        status: org.status,
        is_platform_org: org.is_platform_org,
        default_agent_access: org.default_agent_access,
        default_min_karma: org.default_min_karma,
        repo_count: parseInt(repoCount.rows[0].count),
        created_at: org.created_at,
        updated_at: org.updated_at,
        avatar_url: org.metadata?.avatar_url
      }
    };
  });

  /**
   * Trigger manual sync for an organization
   */
  app.post('/gitswarm/install/:orgId/sync', async (request, reply) => {
    const { orgId } = request.params;

    // Get org details
    const orgResult = await query(`
      SELECT id, github_org_name, github_installation_id, status
      FROM gitswarm_orgs
      WHERE id = $1
    `, [orgId]);

    if (orgResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Organization not found'
      });
    }

    const org = orgResult.rows[0];

    if (org.status !== 'active') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Organization is ${org.status}, cannot sync`
      });
    }

    try {
      // Fetch repositories from GitHub
      const repos = await githubApp.getInstallationRepositories(org.github_installation_id);

      let synced = 0;
      let failed = 0;

      for (const repo of repos || []) {
        try {
          await syncRepository(org.id, repo);
          synced++;
        } catch (error) {
          console.error(`Failed to sync repo ${repo.full_name}:`, error.message);
          failed++;
        }
      }

      return {
        success: true,
        synced,
        failed,
        total: repos?.length || 0
      };
    } catch (error) {
      console.error('Sync failed:', error);
      return reply.status(500).send({
        error: 'Sync Failed',
        message: 'Failed to sync repositories from GitHub'
      });
    }
  });
}

// Helper to sync a repository from GitHub
async function syncRepository(orgId, githubRepo) {
  await query(`
    INSERT INTO gitswarm_repos (
      org_id, github_repo_name, github_repo_id, github_full_name,
      is_private, description, default_branch, primary_language, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
    ON CONFLICT (github_repo_id) DO UPDATE SET
      github_repo_name = $2,
      github_full_name = $4,
      is_private = $5,
      description = $6,
      default_branch = $7,
      primary_language = $8,
      status = 'active',
      updated_at = NOW()
  `, [
    orgId,
    githubRepo.name,
    githubRepo.id,
    githubRepo.full_name,
    githubRepo.private,
    githubRepo.description,
    githubRepo.default_branch || 'main',
    githubRepo.language
  ]);
}
