import { query } from '../config/database.js';
import { githubApp } from '../services/github.js';

export async function webhookRoutes(app) {
  // GitHub webhook handler
  app.post('/webhooks/github', {
    config: {
      rawBody: true, // Need raw body for signature verification
    },
  }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'];
    const event = request.headers['x-github-event'];
    const deliveryId = request.headers['x-github-delivery'];

    if (!signature) {
      return reply.status(401).send({ error: 'Missing signature' });
    }

    // Verify webhook signature
    const rawBody = JSON.stringify(request.body);
    if (!githubApp.verifyWebhookSignature(rawBody, signature)) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    app.log.info({ event, deliveryId }, 'Received GitHub webhook');

    try {
      switch (event) {
        case 'pull_request':
          await handlePullRequestEvent(request.body);
          break;
        case 'pull_request_review':
          await handlePullRequestReviewEvent(request.body);
          break;
        case 'installation':
          await handleInstallationEvent(request.body);
          break;
        case 'installation_repositories':
          await handleInstallationRepositoriesEvent(request.body);
          break;
        case 'push':
          await handlePushEvent(request.body);
          break;
        default:
          app.log.info({ event }, 'Unhandled GitHub event');
      }

      return { received: true };
    } catch (error) {
      app.log.error({ error: error.message }, 'Error processing webhook');
      return reply.status(500).send({ error: 'Webhook processing failed' });
    }
  });
}

// Handle pull request events (opened, closed, merged, etc.)
async function handlePullRequestEvent(payload) {
  const { action, pull_request, repository } = payload;
  const prUrl = pull_request.html_url;

  // Find the patch associated with this PR
  const patchResult = await query(
    `SELECT id, status FROM patches WHERE github_pr_url = $1`,
    [prUrl]
  );

  if (patchResult.rows.length === 0) {
    // Not a BotHub-managed PR
    return;
  }

  const patch = patchResult.rows[0];

  switch (action) {
    case 'closed':
      if (pull_request.merged) {
        // PR was merged
        await query(
          `UPDATE patches SET status = 'merged', updated_at = NOW() WHERE id = $1`,
          [patch.id]
        );

        // Award karma to the author
        const patchDetails = await query(
          `SELECT author_id FROM patches WHERE id = $1`,
          [patch.id]
        );
        if (patchDetails.rows.length > 0) {
          await query(
            `UPDATE agents SET karma = karma + 25 WHERE id = $1`,
            [patchDetails.rows[0].author_id]
          );
        }

        // Award karma to reviewers
        const reviews = await query(
          `SELECT DISTINCT reviewer_id FROM patch_reviews WHERE patch_id = $1 AND verdict = 'approve'`,
          [patch.id]
        );
        for (const review of reviews.rows) {
          await query(
            `UPDATE agents SET karma = karma + 5 WHERE id = $1`,
            [review.reviewer_id]
          );
        }
      } else {
        // PR was closed without merging
        await query(
          `UPDATE patches SET status = 'closed', updated_at = NOW() WHERE id = $1`,
          [patch.id]
        );
      }
      break;

    case 'reopened':
      await query(
        `UPDATE patches SET status = 'open', updated_at = NOW() WHERE id = $1`,
        [patch.id]
      );
      break;

    case 'synchronize':
      // New commits pushed to the PR
      await query(
        `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
        [patch.id]
      );
      break;
  }
}

// Handle pull request review events
async function handlePullRequestReviewEvent(payload) {
  const { action, review, pull_request } = payload;
  const prUrl = pull_request.html_url;

  if (action !== 'submitted') {
    return;
  }

  // Find the patch
  const patchResult = await query(
    `SELECT id FROM patches WHERE github_pr_url = $1`,
    [prUrl]
  );

  if (patchResult.rows.length === 0) {
    return;
  }

  const patch = patchResult.rows[0];

  // Log external review (we can't map GitHub users to BotHub agents)
  // This is just for tracking that external reviews happened
  console.log(`External GitHub review on patch ${patch.id}: ${review.state} by ${review.user.login}`);
}

// Handle app installation events
async function handleInstallationEvent(payload) {
  const { action, installation, repositories } = payload;

  switch (action) {
    case 'created':
      console.log(`App installed on ${installation.account.login}, installation ID: ${installation.id}`);

      // Create or update GitSwarm org
      await query(`
        INSERT INTO gitswarm_orgs (
          github_org_name, github_org_id, github_installation_id, status
        ) VALUES ($1, $2, $3, 'active')
        ON CONFLICT (github_installation_id) DO UPDATE SET
          github_org_name = $1,
          status = 'active',
          updated_at = NOW()
      `, [
        installation.account.login,
        installation.account.id,
        installation.id
      ]);

      // Get the org ID for syncing repos
      const orgResult = await query(`
        SELECT id FROM gitswarm_orgs WHERE github_installation_id = $1
      `, [installation.id]);

      if (orgResult.rows.length > 0 && repositories) {
        const orgId = orgResult.rows[0].id;
        // Sync initial repositories
        for (const repo of repositories) {
          await syncGitSwarmRepository(orgId, repo);
        }
      }
      break;

    case 'deleted':
      console.log(`App uninstalled from ${installation.account.login}`);

      // Mark any forges using this installation as disconnected
      await query(
        `UPDATE forges SET github_app_installation_id = NULL WHERE github_app_installation_id = $1`,
        [installation.id]
      );

      // Mark GitSwarm org as uninstalled
      await query(`
        UPDATE gitswarm_orgs SET status = 'uninstalled', updated_at = NOW()
        WHERE github_installation_id = $1
      `, [installation.id]);
      break;

    case 'suspend':
      console.log(`App suspended on ${installation.account.login}`);

      // Mark GitSwarm org as suspended
      await query(`
        UPDATE gitswarm_orgs SET status = 'suspended', updated_at = NOW()
        WHERE github_installation_id = $1
      `, [installation.id]);
      break;

    case 'unsuspend':
      console.log(`App unsuspended on ${installation.account.login}`);

      // Mark GitSwarm org as active
      await query(`
        UPDATE gitswarm_orgs SET status = 'active', updated_at = NOW()
        WHERE github_installation_id = $1
      `, [installation.id]);
      break;
  }
}

// Handle installation_repositories events (repos added/removed from installation)
async function handleInstallationRepositoriesEvent(payload) {
  const { action, installation, repositories_added, repositories_removed } = payload;

  // Get the GitSwarm org
  const orgResult = await query(`
    SELECT id FROM gitswarm_orgs WHERE github_installation_id = $1
  `, [installation.id]);

  if (orgResult.rows.length === 0) {
    console.log(`No GitSwarm org found for installation ${installation.id}`);
    return;
  }

  const orgId = orgResult.rows[0].id;

  if (action === 'added' && repositories_added) {
    for (const repo of repositories_added) {
      await syncGitSwarmRepository(orgId, repo);
    }
  }

  if (action === 'removed' && repositories_removed) {
    for (const repo of repositories_removed) {
      await query(`
        UPDATE gitswarm_repos SET status = 'removed', updated_at = NOW()
        WHERE github_repo_id = $1
      `, [repo.id]);
    }
  }
}

// Helper to sync a repository to GitSwarm
async function syncGitSwarmRepository(orgId, githubRepo) {
  try {
    await query(`
      INSERT INTO gitswarm_repos (
        org_id, github_repo_name, github_repo_id, github_full_name,
        is_private, description, default_branch, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
      ON CONFLICT (github_repo_id) DO UPDATE SET
        github_repo_name = $2,
        github_full_name = $4,
        is_private = $5,
        description = $6,
        default_branch = $7,
        status = 'active',
        updated_at = NOW()
    `, [
      orgId,
      githubRepo.name,
      githubRepo.id,
      githubRepo.full_name,
      githubRepo.private,
      githubRepo.description,
      githubRepo.default_branch || 'main'
    ]);
  } catch (error) {
    console.error(`Failed to sync repository ${githubRepo.full_name}:`, error.message);
  }
}

// Handle push events (for tracking commits)
async function handlePushEvent(payload) {
  const { ref, commits, repository } = payload;

  // We mainly care about pushes to branches that correspond to patches
  const branchName = ref.replace('refs/heads/', '');

  if (!branchName.startsWith('bothub/patch-')) {
    return;
  }

  // Find the patch
  const patchResult = await query(
    `SELECT id FROM patches WHERE github_branch = $1`,
    [branchName]
  );

  if (patchResult.rows.length === 0) {
    return;
  }

  // Update the patch's updated_at timestamp
  await query(
    `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
    [patchResult.rows[0].id]
  );
}
