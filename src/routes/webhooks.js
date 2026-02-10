import { query } from '../config/database.js';
import { githubApp } from '../services/github.js';

let _activityService = null;
let _pluginEngine = null;
let _configSyncService = null;

export async function webhookRoutes(app, options = {}) {
  _activityService = options.activityService || null;
  _pluginEngine = options.pluginEngine || null;
  _configSyncService = options.configSyncService || null;
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
        case 'issues':
          await handleIssuesEvent(request.body);
          break;
        case 'issue_comment':
          await handleIssueCommentEvent(request.body);
          break;
        case 'workflow_run':
          await handleWorkflowRunEvent(request.body);
          break;
        default:
          app.log.info({ event }, 'Unhandled GitHub event');
      }

      // Route event through plugin engine (non-blocking)
      if (_pluginEngine) {
        _pluginEngine.processWebhookEvent(event, request.body)
          .catch(err => app.log.error({ error: err.message }, 'Plugin engine error'));

        // Post-hoc audit: if this event represents a mutation that could have
        // been produced by a dispatched AI workflow, attribute it for budget tracking
        const auditAction = _mapWebhookToAuditAction(event, request.body);
        if (auditAction) {
          const auditRepoId = await _resolveRepoIdFromPayload(request.body);
          if (auditRepoId) {
            _pluginEngine.auditWorkflowAction(auditRepoId, auditAction, request.body)
              .catch(err => app.log.error({ error: err.message }, 'Audit action error'));
          }
        }
      }

      // Check if push touches .gitswarm/ files — trigger config sync
      if (event === 'push' && _configSyncService) {
        const commits = request.body.commits || [];
        const touchesConfig = commits.some(c =>
          [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]
            .some(f => f.startsWith('.gitswarm/'))
        );
        if (touchesConfig) {
          const repoId = await _resolveRepoIdFromPayload(request.body);
          if (repoId) {
            _configSyncService.syncRepoConfig(repoId)
              .catch(err => app.log.error({ error: err.message }, 'Config sync error on push'));
          }
        }
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

// Handle PRs created externally on GitSwarm repos — create stream records
async function handleExternalPullRequest(payload) {
  const { action, pull_request, repository } = payload;

  // Check if repo is a GitSwarm repo
  const repoResult = await query(`
    SELECT id, github_full_name FROM gitswarm_repos
    WHERE github_repo_id = $1 AND status = 'active'
  `, [repository.id]);

  if (repoResult.rows.length === 0) return;

  const repo = repoResult.rows[0];

  // Map the author
  const mapping = await ensureGitHubUserMapping(pull_request.user);
  const agentId = mapping?.agent_id || null;

  if (action === 'opened') {
    // Create a stream record for this PR
    const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
    await query(`
      INSERT INTO gitswarm_streams (
        id, repo_id, agent_id, name, branch, source,
        github_pr_number, github_pr_url, base_branch
      ) VALUES ($1, $2, $3, $4, $5, 'github_pr', $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        agent_id = COALESCE(EXCLUDED.agent_id, gitswarm_streams.agent_id),
        updated_at = NOW()
    `, [
      streamId, repo.id, agentId,
      pull_request.title,
      pull_request.head.ref,
      pull_request.number,
      pull_request.html_url,
      pull_request.base.ref,
    ]);

    console.log(`Stream ${streamId} created for PR #${pull_request.number} on ${repo.github_full_name}`);

    if (_activityService) {
      await _activityService.logActivity({
        agent_id: agentId,
        event_type: 'stream_created',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repo.id, source: 'github_pr', pr_number: pull_request.number },
      });
    }

    // Emit gitswarm event for stream submission
    emitGitswarmEvent(repo.id, 'stream_submitted', {
      stream_id: streamId,
      pr_number: pull_request.number,
      stream_name: pull_request.head.ref,
      agent: { id: agentId },
    });
  } else if (action === 'closed') {
    const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
    const newStatus = pull_request.merged ? 'merged' : 'abandoned';

    await query(`
      UPDATE gitswarm_streams SET status = $1, updated_at = NOW()
      WHERE id = $2
    `, [newStatus, streamId]);

    if (pull_request.merged && agentId) {
      // Record merge
      await query(`
        INSERT INTO gitswarm_merges (repo_id, stream_id, agent_id, merge_commit, target_branch)
        VALUES ($1, $2, $3, $4, $5)
      `, [repo.id, streamId, agentId, pull_request.merge_commit_sha, pull_request.base.ref]);

      // Award karma
      await query(`UPDATE agents SET karma = karma + 25 WHERE id = $1`, [agentId]);

      if (_activityService) {
        await _activityService.logActivity({
          agent_id: agentId,
          event_type: 'stream_merged',
          target_type: 'stream',
          target_id: streamId,
          metadata: { repo_id: repo.id, merge_commit: pull_request.merge_commit_sha },
        });
      }

      // Emit gitswarm event for stream merge
      emitGitswarmEvent(repo.id, 'stream_merged', {
        stream_id: streamId,
        pr_number: pull_request.number,
        stream_name: pull_request.head.ref,
        merge_commit: pull_request.merge_commit_sha,
        agent: { id: agentId },
      });
    } else if (_activityService) {
      // PR closed without merge (abandoned)
      await _activityService.logActivity({
        agent_id: agentId,
        event_type: 'stream_abandoned',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repo.id },
      });
    }
  } else if (action === 'synchronize') {
    // New commits pushed — record them
    const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
    const headSha = pull_request.head.sha;

    await query(`
      INSERT INTO gitswarm_stream_commits (stream_id, agent_id, commit_hash, message)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [streamId, agentId, headSha, `Push to PR #${pull_request.number}`]);
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
      // No legacy patch — check if there's a stream for this PR
      // and write the review directly to stream_reviews
      await writeReviewToStream(repository, pull_request, review, reviewerMapping);
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
    // Agent review - insert/update normally (legacy patch_reviews)
    await query(`
      INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, is_human)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET
        verdict = $3,
        feedback = $4,
        reviewed_at = NOW()
    `, [patch.id, reviewerMapping.agent_id, verdict, review.body]);

    // Also insert into gitswarm_stream_reviews if there's a linked stream
    const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
    await query(`
      INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
        verdict = $3, feedback = $4, reviewed_at = NOW()
    `, [streamId, reviewerMapping.agent_id, verdict, review.body]).catch(() => {
      // Stream may not exist yet — ignore
    });

    // Update reviewer stats
    await updateReviewerStats(reviewerMapping.agent_id, verdict);

    // Check consensus after agent review
    if (verdict !== 'comment' && patch.repo_id) {
      const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
      await checkAndEmitConsensus(
        patch.repo_id, streamId, pull_request.number, pull_request.head.ref
      );
    }
  } else {
    // Human review from GitHub - store differently
    await storeHumanReview(patch.id, review, reviewerMapping);

    // Also record in stream reviews if there's a linked stream
    const humanId = await getHumanReviewerPlaceholder(review.user);
    if (humanId) {
      const streamId = `gh-pr-${repository.id}-${pull_request.number}`;
      await query(`
        INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
          verdict = $3, feedback = $4, reviewed_at = NOW()
      `, [streamId, humanId, verdict, review.body]).catch(() => {});
    }
  }

  console.log(`Review synced: ${review.user.login} ${verdict} on patch ${patch.id}`);
}

// Write a review directly to gitswarm_stream_reviews when no legacy patch exists
async function writeReviewToStream(repository, pull_request, review, reviewerMapping) {
  const streamId = `gh-pr-${repository.id}-${pull_request.number}`;

  // Verify stream exists
  const streamResult = await query(
    `SELECT id, repo_id FROM gitswarm_streams WHERE id = $1`,
    [streamId]
  );

  if (streamResult.rows.length === 0) {
    // Stream doesn't exist yet — create it on the fly (PR was opened before we tracked it)
    const repoResult = await query(
      `SELECT id FROM gitswarm_repos WHERE github_repo_id = $1 AND status = 'active'`,
      [repository.id]
    );
    if (repoResult.rows.length === 0) {
      console.log(`Review on untracked PR (no repo): ${pull_request.html_url}`);
      return;
    }

    const mapping = await ensureGitHubUserMapping(pull_request.user);
    await query(`
      INSERT INTO gitswarm_streams (id, repo_id, agent_id, name, branch, source, github_pr_number, github_pr_url, base_branch)
      VALUES ($1, $2, $3, $4, $5, 'github_pr', $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
    `, [
      streamId, repoResult.rows[0].id, mapping?.agent_id,
      pull_request.title, pull_request.head.ref,
      pull_request.number, pull_request.html_url, pull_request.base.ref,
    ]);
  }

  const verdictMap = {
    'approved': 'approve',
    'changes_requested': 'request_changes',
    'commented': 'comment',
  };
  const verdict = verdictMap[review.state.toLowerCase()] || 'comment';
  const isHuman = !reviewerMapping?.agent_id;
  const reviewerId = reviewerMapping?.agent_id || await getHumanReviewerPlaceholder(review.user);

  if (reviewerId) {
    await query(`
      INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
        verdict = $3, feedback = $4, reviewed_at = NOW()
    `, [streamId, reviewerId, verdict, review.body, isHuman]);

    if (!isHuman) {
      await updateReviewerStats(reviewerId, verdict);
    }
  }

  if (_activityService && reviewerId) {
    await _activityService.logActivity({
      agent_id: reviewerId,
      event_type: 'review_submitted',
      target_type: 'stream',
      target_id: streamId,
      metadata: { verdict, is_human: isHuman },
    });
  }

  console.log(`Review written to stream ${streamId}: ${review.user.login} ${verdict}`);

  // Check consensus after each review and emit gitswarm events
  if (verdict !== 'comment') {
    const repoId = streamResult.rows[0]?.repo_id
      || (await query(`SELECT repo_id FROM gitswarm_streams WHERE id = $1`, [streamId])).rows[0]?.repo_id;
    if (repoId) {
      await checkAndEmitConsensus(
        repoId, streamId, pull_request.number, pull_request.head.ref
      );
    }
  }
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

// Handle push events (for tracking commits on streams and patches)
async function handlePushEvent(payload) {
  const { ref, commits, repository } = payload;

  const branchName = ref.replace('refs/heads/', '');

  // Check if this push corresponds to a stream branch
  const streamResult = await query(`
    SELECT s.id, s.agent_id FROM gitswarm_streams s
    JOIN gitswarm_repos r ON s.repo_id = r.id
    WHERE r.github_repo_id = $1 AND s.branch = $2 AND s.status = 'active'
  `, [repository.id, branchName]);

  if (streamResult.rows.length > 0) {
    const stream = streamResult.rows[0];
    // Record each new commit on the stream
    if (commits) {
      for (const commit of commits) {
        await query(`
          INSERT INTO gitswarm_stream_commits (stream_id, agent_id, commit_hash, message)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `, [stream.id, stream.agent_id, commit.id, commit.message]);
      }
    }
    return;
  }

  // Legacy: check for old-style patch branches
  if (branchName.startsWith('bothub/patch-')) {
    const patchResult = await query(
      `SELECT id FROM patches WHERE github_branch = $1`,
      [branchName]
    );

    if (patchResult.rows.length > 0) {
      await query(
        `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
        [patchResult.rows[0].id]
      );
    }
  }
}

// ============================================================
// Issue Events (for GitSwarm bounties)
// ============================================================

// Handle issue events (opened, closed, labeled, etc.)
async function handleIssuesEvent(payload) {
  const { action, issue, repository, label } = payload;

  // Check if this is a GitSwarm repo
  const repoResult = await query(`
    SELECT id, github_full_name FROM gitswarm_repos
    WHERE github_repo_id = $1 AND status = 'active'
  `, [repository.id]);

  if (repoResult.rows.length === 0) {
    return; // Not a GitSwarm-tracked repo
  }

  const repo = repoResult.rows[0];

  // Map the issue author
  if (issue.user) {
    await ensureGitHubUserMapping(issue.user);
  }

  switch (action) {
    case 'opened':
      console.log(`New issue #${issue.number} opened on GitSwarm repo ${repo.github_full_name}`);
      // Could auto-create bounty based on labels or config
      break;

    case 'closed':
      // If issue has a bounty, check if it should be marked as complete
      await handleIssueClosedForBounty(repo.id, issue);
      break;

    case 'labeled':
      // Check if bounty label was added
      if (label && label.name.toLowerCase().includes('bounty')) {
        console.log(`Bounty label added to issue #${issue.number}`);
        // Could auto-create bounty
      }
      break;

    case 'unlabeled':
      // Check if bounty label was removed
      if (label && label.name.toLowerCase().includes('bounty')) {
        console.log(`Bounty label removed from issue #${issue.number}`);
      }
      break;

    case 'assigned':
      // Track assignment for bounty claims
      if (issue.assignee) {
        await ensureGitHubUserMapping(issue.assignee);
        console.log(`Issue #${issue.number} assigned to ${issue.assignee.login}`);
      }
      break;
  }
}

// Handle issue closed for task/bounty completion
async function handleIssueClosedForBounty(repoId, issue) {
  // Check if there's a task for this issue
  const taskResult = await query(`
    SELECT id, status FROM gitswarm_tasks
    WHERE repo_id = $1 AND github_issue_number = $2
  `, [repoId, issue.number]);

  if (taskResult.rows.length === 0) {
    return; // No task for this issue
  }

  const task = taskResult.rows[0];

  // If task is open or claimed, update status
  if (['open', 'claimed'].includes(task.status)) {
    if (issue.state_reason === 'completed' || issue.state_reason === 'not_planned') {
      await query(`
        UPDATE gitswarm_tasks SET status = 'submitted', updated_at = NOW()
        WHERE id = $1 AND status IN ('open', 'claimed')
      `, [task.id]);

      console.log(`Task ${task.id} moved to submitted state after issue #${issue.number} closed`);
    }
  }
}

// Handle issue comment events
async function handleIssueCommentEvent(payload) {
  const { action, comment, issue, repository } = payload;

  if (action !== 'created') {
    return; // Only process new comments
  }

  // Check if this is a GitSwarm repo
  const repoResult = await query(`
    SELECT id, github_full_name FROM gitswarm_repos
    WHERE github_repo_id = $1 AND status = 'active'
  `, [repository.id]);

  if (repoResult.rows.length === 0) {
    return; // Not a GitSwarm-tracked repo
  }

  const repo = repoResult.rows[0];

  // Map the commenter
  if (comment.user) {
    await ensureGitHubUserMapping(comment.user);
  }

  // Check for GitSwarm commands in comment
  const commandMatch = comment.body.match(/^\/gitswarm\s+(\w+)(?:\s+(.*))?$/im);

  if (commandMatch) {
    const [, command, args] = commandMatch;
    await handleGitSwarmCommand(repo.id, issue, comment, command, args);
  }

  // Check for bounty claim commands
  const bountyMatch = comment.body.match(/^\/bounty\s+(\w+)(?:\s+(.*))?$/im);

  if (bountyMatch) {
    const [, command, args] = bountyMatch;
    await handleBountyCommand(repo.id, issue, comment, command, args);
  }
}

// Handle /gitswarm commands in issue comments
async function handleGitSwarmCommand(repoId, issue, comment, command, args) {
  console.log(`GitSwarm command in issue #${issue.number}: /${command} ${args || ''}`);

  // Map commenter to agent if possible
  const userMapping = await query(`
    SELECT agent_id FROM github_user_mappings WHERE github_user_id = $1
  `, [comment.user.id]);

  if (!userMapping.rows[0]?.agent_id) {
    console.log(`User ${comment.user.login} not mapped to an agent`);
    return;
  }

  switch (command.toLowerCase()) {
    case 'status':
      // Could post a status comment
      console.log(`Status requested for repo ${repoId}`);
      break;

    case 'help':
      // Could post a help comment
      console.log('Help requested');
      break;

    default:
      console.log(`Unknown gitswarm command: ${command}`);
  }
}

// Handle /bounty commands in issue comments (now using gitswarm_tasks)
async function handleBountyCommand(repoId, issue, comment, command, args) {
  console.log(`Bounty command in issue #${issue.number}: /${command} ${args || ''}`);

  // Check if there's a task for this issue
  const taskResult = await query(`
    SELECT id, status, amount FROM gitswarm_tasks
    WHERE repo_id = $1 AND github_issue_number = $2
  `, [repoId, issue.number]);

  // Map commenter to agent
  const userMapping = await query(`
    SELECT agent_id FROM github_user_mappings WHERE github_user_id = $1
  `, [comment.user.id]);

  const agentId = userMapping.rows[0]?.agent_id;

  switch (command.toLowerCase()) {
    case 'claim':
      if (taskResult.rows.length === 0) {
        console.log(`No task exists for issue #${issue.number}`);
        return;
      }
      if (!agentId) {
        console.log(`User ${comment.user.login} not mapped to an agent`);
        return;
      }
      console.log(`Agent ${agentId} claiming task for issue #${issue.number}`);
      try {
        await query(`
          INSERT INTO gitswarm_task_claims (task_id, agent_id)
          VALUES ($1, $2)
          ON CONFLICT (task_id, agent_id) DO NOTHING
        `, [taskResult.rows[0].id, agentId]);

        await query(`
          UPDATE gitswarm_tasks SET status = 'claimed', updated_at = NOW()
          WHERE id = $1 AND status = 'open'
        `, [taskResult.rows[0].id]);
      } catch (error) {
        console.error('Failed to claim task:', error.message);
      }
      break;

    case 'abandon':
      if (taskResult.rows.length === 0 || !agentId) {
        return;
      }
      console.log(`Agent ${agentId} abandoning task for issue #${issue.number}`);
      try {
        await query(`
          UPDATE gitswarm_task_claims SET status = 'abandoned'
          WHERE task_id = $1 AND agent_id = $2 AND status = 'active'
        `, [taskResult.rows[0].id, agentId]);
      } catch (error) {
        console.error('Failed to abandon task:', error.message);
      }
      break;

    case 'status':
      if (taskResult.rows.length === 0) {
        console.log(`No task exists for issue #${issue.number}`);
      } else {
        console.log(`Task for issue #${issue.number}: ${taskResult.rows[0].amount} credits, status: ${taskResult.rows[0].status}`);
      }
      break;

    default:
      console.log(`Unknown bounty command: ${command}`);
  }
}

// ============================================================
// Workflow Run Events (passive execution tracking)
// ============================================================

async function handleWorkflowRunEvent(payload) {
  const { action, workflow_run, repository } = payload;

  // Only process completed workflow runs for gitswarm workflows
  if (action !== 'completed') return;
  if (!workflow_run?.name?.toLowerCase().includes('gitswarm')) return;

  const repoId = await _resolveRepoIdFromPayload(payload);
  if (!repoId) return;

  const conclusion = workflow_run.conclusion; // 'success', 'failure', 'cancelled', etc.

  // Resolve dispatched execution records that match this workflow
  if (_pluginEngine) {
    try {
      await _pluginEngine.resolveWorkflowCompletion(
        repoId,
        workflow_run.name,
        conclusion
      );
    } catch (err) {
      console.error('Failed to resolve workflow completion:', err.message);
    }
  }
}

// ============================================================
// Gitswarm Event Emission Helpers
// ============================================================

/**
 * Emit a gitswarm event through the plugin engine.
 * Called at lifecycle points where gitswarm-specific events occur.
 * Fire-and-forget (non-blocking).
 */
function emitGitswarmEvent(repoId, eventType, payload) {
  if (!_pluginEngine) return;
  _pluginEngine.processGitswarmEvent(repoId, eventType, payload)
    .catch(err => console.error(`Gitswarm event ${eventType} failed:`, err.message));
}

/**
 * Check consensus status after a review and emit events if threshold is met.
 * Called after reviews are recorded.
 */
async function checkAndEmitConsensus(repoId, streamId, prNumber, branchName) {
  try {
    const reviews = await query(`
      SELECT verdict FROM gitswarm_stream_reviews WHERE stream_id = $1
    `, [streamId]);

    const approvals = reviews.rows.filter(r => r.verdict === 'approve').length;
    const rejections = reviews.rows.filter(r => r.verdict === 'request_changes').length;
    const total = approvals + rejections;
    if (total === 0) return;

    const repoConfig = await query(`
      SELECT consensus_threshold FROM gitswarm_repos WHERE id = $1
    `, [repoId]);
    const threshold = repoConfig.rows[0]?.consensus_threshold || 0.66;
    const ratio = approvals / total;

    // Get stream author info
    const stream = await query(`
      SELECT agent_id FROM gitswarm_streams WHERE id = $1
    `, [streamId]);
    const agentId = stream.rows[0]?.agent_id;

    let agentKarma = 0;
    if (agentId) {
      const karmaResult = await query(`SELECT karma FROM agents WHERE id = $1`, [agentId]);
      agentKarma = karmaResult.rows[0]?.karma || 0;
    }

    if (ratio >= threshold) {
      // Guard: only emit consensus_reached once per stream per hour
      const alreadyEmitted = await query(`
        SELECT id FROM gitswarm_plugin_executions
        WHERE repo_id = $1 AND trigger_event = 'gitswarm.consensus_reached'
          AND trigger_payload::text LIKE $2
          AND created_at > NOW() - INTERVAL '1 hour'
        LIMIT 1
      `, [repoId, `%${streamId}%`]);

      if (alreadyEmitted.rows.length === 0) {
        emitGitswarmEvent(repoId, 'consensus_reached', {
          stream_id: streamId,
          pr_number: prNumber,
          stream_name: branchName,
          consensus: { achieved: ratio, approvals, rejections, threshold },
          agent: { id: agentId, karma: agentKarma },
        });
      }
    } else if (rejections > 0 && rejections >= total * (1 - threshold)) {
      // Guard: only emit consensus_blocked once per stream per hour
      const blockedAlreadyEmitted = await query(`
        SELECT id FROM gitswarm_plugin_executions
        WHERE repo_id = $1 AND trigger_event = 'gitswarm.consensus_blocked'
          AND trigger_payload::text LIKE $2
          AND created_at > NOW() - INTERVAL '1 hour'
        LIMIT 1
      `, [repoId, `%${streamId}%`]);

      if (blockedAlreadyEmitted.rows.length === 0) {
        emitGitswarmEvent(repoId, 'consensus_blocked', {
          stream_id: streamId,
          pr_number: prNumber,
          stream_name: branchName,
          consensus: { achieved: ratio, approvals, rejections, threshold },
        });
      }
    }
  } catch (err) {
    console.error('checkAndEmitConsensus failed:', err.message);
  }
}

/**
 * Map a webhook event to an audit action name.
 * Returns null if the event doesn't represent a trackable mutation.
 */
function _mapWebhookToAuditAction(event, payload) {
  const action = payload.action;
  switch (event) {
    case 'issues':
      if (action === 'labeled') return 'add_label';
      if (action === 'unlabeled') return 'remove_label';
      if (action === 'closed') return 'close_issue';
      return null;
    case 'issue_comment':
      if (action === 'created') return 'add_comment';
      return null;
    case 'pull_request':
      if (action === 'labeled') return 'add_label';
      if (action === 'opened') return 'create_pr';
      if (action === 'closed' && payload.pull_request?.merged) return 'merge_stream';
      return null;
    case 'pull_request_review':
      if (payload.review?.state === 'approved') return 'auto_approve';
      return null;
    case 'create':
      if (payload.ref_type === 'branch') return 'create_branch';
      if (payload.ref_type === 'tag') return 'tag_release';
      return null;
    default:
      return null;
  }
}

// Helper to resolve gitswarm repo ID from webhook payload
async function _resolveRepoIdFromPayload(payload) {
  const repository = payload.repository;
  if (!repository) return null;

  const result = await query(`
    SELECT id FROM gitswarm_repos
    WHERE github_repo_id = $1 AND status = 'active'
  `, [repository.id]);

  return result.rows[0]?.id || null;
}
