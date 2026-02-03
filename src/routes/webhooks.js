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

// ============================================================
// GitHub User Mapping
// ============================================================

// Ensure a GitHub user is mapped in our database
async function ensureGitHubUserMapping(githubUser) {
  if (!githubUser || !githubUser.id) return null;

  try {
    const result = await query(`
      INSERT INTO github_user_mappings (github_user_id, github_username, avatar_url)
      VALUES ($1, $2, $3)
      ON CONFLICT (github_user_id) DO UPDATE SET
        github_username = $2,
        avatar_url = $3,
        updated_at = NOW()
      RETURNING id, github_user_id, github_username, agent_id
    `, [githubUser.id, githubUser.login, githubUser.avatar_url]);

    return result.rows[0];
  } catch (error) {
    console.error('Failed to map GitHub user:', error.message);
    return null;
  }
}

// ============================================================
// Pull Request Events
// ============================================================

// Handle pull request events (opened, closed, merged, etc.)
async function handlePullRequestEvent(payload) {
  const { action, pull_request, repository } = payload;
  const prUrl = pull_request.html_url;

  // Ensure PR author is mapped
  if (pull_request.user) {
    await ensureGitHubUserMapping(pull_request.user);
  }

  // Find the patch associated with this PR (check both patches and gitswarm_patches)
  const patchResult = await query(
    `SELECT p.id, p.status, p.author_id, gp.repo_id as gitswarm_repo_id
     FROM patches p
     LEFT JOIN gitswarm_patches gp ON gp.patch_id = p.id
     WHERE p.github_pr_url = $1`,
    [prUrl]
  );

  if (patchResult.rows.length === 0) {
    // Check if this is a GitSwarm-tracked PR by number
    const gitswarmPatch = await query(`
      SELECT gp.patch_id, gp.repo_id, p.id, p.status, p.author_id
      FROM gitswarm_patches gp
      JOIN patches p ON gp.patch_id = p.id
      JOIN gitswarm_repos r ON gp.repo_id = r.id
      WHERE r.github_repo_id = $1 AND gp.github_pr_number = $2
    `, [repository.id, pull_request.number]);

    if (gitswarmPatch.rows.length === 0) {
      // Not a BotHub-managed PR - could be an external PR
      // Try to track it if it's in a GitSwarm repo
      await handleExternalPullRequest(payload);
      return;
    }

    // Use the gitswarm patch
    const patch = gitswarmPatch.rows[0];
    await processPullRequestAction(action, pull_request, patch);
    return;
  }

  const patch = patchResult.rows[0];
  await processPullRequestAction(action, pull_request, patch);
}

// Process the PR action on a patch
async function processPullRequestAction(action, pull_request, patch) {
  switch (action) {
    case 'closed':
      if (pull_request.merged) {
        // PR was merged
        await query(
          `UPDATE patches SET status = 'merged', updated_at = NOW() WHERE id = $1`,
          [patch.id]
        );

        // Update GitSwarm patch state
        await query(`
          UPDATE gitswarm_patches SET github_pr_state = 'merged', last_synced_at = NOW()
          WHERE patch_id = $1
        `, [patch.id]);

        // Award karma to the author
        if (patch.author_id) {
          await query(
            `UPDATE agents SET karma = karma + 25 WHERE id = $1`,
            [patch.author_id]
          );
        }

        // Award karma to reviewers and track accuracy
        await awardReviewerKarmaOnMerge(patch.id);
      } else {
        // PR was closed without merging
        await query(
          `UPDATE patches SET status = 'closed', updated_at = NOW() WHERE id = $1`,
          [patch.id]
        );

        await query(`
          UPDATE gitswarm_patches SET github_pr_state = 'closed', last_synced_at = NOW()
          WHERE patch_id = $1
        `, [patch.id]);

        // Track accuracy for reviewers
        await trackReviewerAccuracyOnClose(patch.id);
      }
      break;

    case 'reopened':
      await query(
        `UPDATE patches SET status = 'open', updated_at = NOW() WHERE id = $1`,
        [patch.id]
      );

      await query(`
        UPDATE gitswarm_patches SET github_pr_state = 'open', last_synced_at = NOW()
        WHERE patch_id = $1
      `, [patch.id]);
      break;

    case 'synchronize':
      // New commits pushed to the PR
      await query(
        `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
        [patch.id]
      );

      await query(`
        UPDATE gitswarm_patches SET last_synced_at = NOW()
        WHERE patch_id = $1
      `, [patch.id]);
      break;
  }
}

// Handle PRs created externally on GitSwarm repos
async function handleExternalPullRequest(payload) {
  const { action, pull_request, repository } = payload;

  // Check if repo is a GitSwarm repo
  const repoResult = await query(`
    SELECT id, github_full_name FROM gitswarm_repos
    WHERE github_repo_id = $1 AND status = 'active'
  `, [repository.id]);

  if (repoResult.rows.length === 0) return;

  const repo = repoResult.rows[0];

  if (action === 'opened' || action === 'synchronize') {
    // Track as an externally created PR
    console.log(`External PR #${pull_request.number} on GitSwarm repo ${repo.github_full_name}`);

    // Map the author
    const mapping = await ensureGitHubUserMapping(pull_request.user);

    // If the GitHub user is mapped to a BotHub agent, we could create a patch
    // For now, just log it
    if (mapping && mapping.agent_id) {
      console.log(`PR author ${pull_request.user.login} is mapped to agent ${mapping.agent_id}`);
    }
  }
}

// ============================================================
// Pull Request Review Events
// ============================================================

// Handle pull request review events
async function handlePullRequestReviewEvent(payload) {
  const { action, review, pull_request, repository } = payload;
  const prUrl = pull_request.html_url;

  if (action !== 'submitted') {
    return;
  }

  // Map the reviewer
  const reviewerMapping = await ensureGitHubUserMapping(review.user);

  // Find the patch
  const patchResult = await query(
    `SELECT p.id, gp.repo_id
     FROM patches p
     LEFT JOIN gitswarm_patches gp ON gp.patch_id = p.id
     WHERE p.github_pr_url = $1`,
    [prUrl]
  );

  // Also check by repo and PR number
  let patch;
  if (patchResult.rows.length > 0) {
    patch = patchResult.rows[0];
  } else {
    const gitswarmPatch = await query(`
      SELECT gp.patch_id as id, gp.repo_id
      FROM gitswarm_patches gp
      JOIN gitswarm_repos r ON gp.repo_id = r.id
      WHERE r.github_repo_id = $1 AND gp.github_pr_number = $2
    `, [repository.id, pull_request.number]);

    if (gitswarmPatch.rows.length === 0) {
      console.log(`Review on untracked PR: ${prUrl}`);
      return;
    }
    patch = gitswarmPatch.rows[0];
  }

  // Map GitHub review state to our verdict
  const verdictMap = {
    'approved': 'approve',
    'changes_requested': 'request_changes',
    'commented': 'comment'
  };
  const verdict = verdictMap[review.state.toLowerCase()] || 'comment';

  // Check if the reviewer is mapped to a BotHub agent
  if (reviewerMapping && reviewerMapping.agent_id) {
    // Agent review - insert/update normally
    await query(`
      INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, is_human)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET
        verdict = $3,
        feedback = $4,
        reviewed_at = NOW()
    `, [patch.id, reviewerMapping.agent_id, verdict, review.body]);

    // Update reviewer stats
    await updateReviewerStats(reviewerMapping.agent_id, verdict);
  } else {
    // Human review from GitHub - store differently
    await storeHumanReview(patch.id, review, reviewerMapping);
  }

  console.log(`Review synced: ${review.user.login} ${verdict} on patch ${patch.id}`);
}

// Store human review from GitHub
async function storeHumanReview(patchId, review, userMapping) {
  // We need to handle human reviews specially since they don't have an agent_id
  // Store in a way that checkConsensus can include them

  // First check if we have an existing record for this GitHub user's review
  const existingResult = await query(`
    SELECT id FROM patch_reviews
    WHERE patch_id = $1 AND github_review_id = $2
  `, [patchId, review.id]);

  const verdictMap = {
    'approved': 'approve',
    'changes_requested': 'request_changes',
    'commented': 'comment'
  };
  const verdict = verdictMap[review.state.toLowerCase()] || 'comment';

  if (existingResult.rows.length > 0) {
    // Update existing
    await query(`
      UPDATE patch_reviews SET
        verdict = $1,
        feedback = $2,
        reviewed_at = NOW()
      WHERE id = $3
    `, [verdict, review.body, existingResult.rows[0].id]);
  } else {
    // We need a placeholder agent_id for human reviews
    // Get or create a system "human reviewer" record
    const humanReviewerId = await getHumanReviewerPlaceholder(review.user);

    if (humanReviewerId) {
      await query(`
        INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, is_human, github_review_id)
        VALUES ($1, $2, $3, $4, true, $5)
        ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET
          verdict = $3,
          feedback = $4,
          reviewed_at = NOW(),
          github_review_id = $5
      `, [patchId, humanReviewerId, verdict, review.body, review.id]);
    }
  }
}

// Get or create a placeholder agent for human reviewers
async function getHumanReviewerPlaceholder(githubUser) {
  // Check if we have a mapping for this user
  const mapping = await query(`
    SELECT agent_id FROM github_user_mappings WHERE github_user_id = $1
  `, [githubUser.id]);

  if (mapping.rows.length > 0 && mapping.rows[0].agent_id) {
    return mapping.rows[0].agent_id;
  }

  // For now, we won't create placeholder agents
  // Human reviews without agent mappings will be logged but not counted in consensus
  // In the future, we could create "shadow" agents for GitHub users
  return null;
}

// ============================================================
// Reviewer Stats & Karma
// ============================================================

// Update reviewer statistics
async function updateReviewerStats(agentId, verdict) {
  await query(`
    INSERT INTO reviewer_stats (agent_id, total_reviews, approvals, rejections)
    VALUES ($1, 1, $2, $3)
    ON CONFLICT (agent_id) DO UPDATE SET
      total_reviews = reviewer_stats.total_reviews + 1,
      approvals = reviewer_stats.approvals + $2,
      rejections = reviewer_stats.rejections + $3,
      updated_at = NOW()
  `, [
    agentId,
    verdict === 'approve' ? 1 : 0,
    verdict === 'request_changes' ? 1 : 0
  ]);
}

// Award karma to reviewers when patch is merged
async function awardReviewerKarmaOnMerge(patchId) {
  const reviews = await query(`
    SELECT DISTINCT reviewer_id, verdict FROM patch_reviews
    WHERE patch_id = $1 AND is_human = false
  `, [patchId]);

  for (const review of reviews.rows) {
    let karmaAward = 0;

    if (review.verdict === 'approve') {
      // Approving reviewers get karma
      karmaAward = 5;

      // Update accuracy: approved_then_merged
      await query(`
        UPDATE reviewer_stats SET
          approved_then_merged = approved_then_merged + 1,
          accuracy_score = CASE
            WHEN total_reviews > 0 THEN
              LEAST(1.0, (approved_then_merged + 1.0) / GREATEST(1.0, approvals::numeric))
            ELSE 1.0
          END,
          updated_at = NOW()
        WHERE agent_id = $1
      `, [review.reviewer_id]);
    } else if (review.verdict === 'request_changes') {
      // Those who requested changes on a merged PR - mark for accuracy tracking
      await query(`
        UPDATE reviewer_stats SET
          rejected_then_merged = rejected_then_merged + 1,
          accuracy_score = CASE
            WHEN total_reviews > 0 THEN
              GREATEST(0.0, 1.0 - (rejected_then_merged + 1.0) / GREATEST(1.0, rejections::numeric) * 0.5)
            ELSE 1.0
          END,
          updated_at = NOW()
        WHERE agent_id = $1
      `, [review.reviewer_id]);
    }

    if (karmaAward > 0) {
      await query(
        `UPDATE agents SET karma = karma + $2 WHERE id = $1`,
        [review.reviewer_id, karmaAward]
      );

      // Log karma transaction
      await query(`
        INSERT INTO review_karma_transactions (agent_id, amount, reason, patch_id)
        VALUES ($1, $2, 'review_accurate', $3)
      `, [review.reviewer_id, karmaAward, patchId]);
    }
  }
}

// Track reviewer accuracy when PR is closed without merge
async function trackReviewerAccuracyOnClose(patchId) {
  const reviews = await query(`
    SELECT reviewer_id, verdict FROM patch_reviews
    WHERE patch_id = $1 AND is_human = false AND verdict = 'approve'
  `, [patchId]);

  for (const review of reviews.rows) {
    // Approved but PR was closed - might indicate poor review
    // However, don't penalize heavily since PRs can be closed for many reasons
    await query(`
      UPDATE reviewer_stats SET updated_at = NOW()
      WHERE agent_id = $1
    `, [review.reviewer_id]);
  }
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
