/**
 * Batch Sync & Repo Registration Routes
 *
 * Handles offline queue replay from CLI agents (Mode B) and
 * initial repo registration when a CLI agent first connects.
 */
import { query } from '../../config/database.js';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

const permissionService = new GitSwarmPermissionService();

export async function syncRoutes(app, options = {}) {
  const { activityService, pluginEngine } = options;
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  // ============================================================
  // Batch Sync (offline queue replay)
  // ============================================================

  app.post('/gitswarm/sync/batch', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['events'],
        properties: {
          events: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['seq', 'type', 'data'],
              properties: {
                seq: { type: 'integer' },
                type: { type: 'string' },
                data: { type: 'object' },
                created_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const agentId = request.agent.id;
    const { events } = request.body;
    const results = [];

    for (const event of events) {
      try {
        await processSyncEvent(event.type, event.data, agentId, { activityService, pluginEngine });
        results.push({ seq: event.seq, status: 'ok' });
      } catch (err) {
        if (err.code === '23505' || err.message?.includes('UNIQUE constraint') || err.message?.includes('duplicate')) {
          // Duplicate — idempotent success
          results.push({ seq: event.seq, status: 'duplicate' });
        } else {
          results.push({ seq: event.seq, status: 'error', message: err.message });
          break; // Stop processing to preserve order
        }
      }
    }

    return { results };
  });

  // ============================================================
  // Repo Registration (CLI first-connect)
  // ============================================================

  app.post('/gitswarm/repos/register', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          ownership_model: { type: 'string', enum: ['solo', 'guild', 'open'] },
          merge_mode: { type: 'string', enum: ['swarm', 'review', 'gated'] },
          consensus_threshold: { type: 'number', minimum: 0, maximum: 1 },
          min_reviews: { type: 'integer', minimum: 1 },
          buffer_branch: { type: 'string' },
          promote_target: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const agentId = request.agent.id;
    const {
      name, description = '',
      ownership_model = 'solo', merge_mode = 'review',
      consensus_threshold = 0.66, min_reviews = 1,
      buffer_branch = 'buffer', promote_target = 'main',
    } = request.body;

    // Find or create personal org for this agent
    let orgResult = await query(
      `SELECT id FROM gitswarm_orgs WHERE owner_id = $1 AND is_personal = true`,
      [agentId]
    );

    let orgId;
    if (orgResult.rows.length > 0) {
      orgId = orgResult.rows[0].id;
    } else {
      // Create personal org
      const agentResult = await query(
        `SELECT name FROM agents WHERE id = $1`, [agentId]
      );
      const agentName = agentResult.rows[0]?.name || 'unknown';

      const insertResult = await query(
        `INSERT INTO gitswarm_orgs (name, owner_id, is_personal)
         VALUES ($1, $2, true)
         RETURNING id`,
        [agentName, agentId]
      );
      orgId = insertResult.rows[0].id;
    }

    // Create repo under the org (or return existing)
    const existing = await query(
      `SELECT id, org_id FROM gitswarm_repos WHERE org_id = $1 AND name = $2`,
      [orgId, name]
    );

    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id, org_id: orgId, existing: true };
    }

    const repoResult = await query(
      `INSERT INTO gitswarm_repos (
        org_id, name, description, ownership_model, merge_mode,
        consensus_threshold, min_reviews, buffer_branch, promote_target
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [orgId, name, description, ownership_model, merge_mode,
       consensus_threshold, min_reviews, buffer_branch, promote_target]
    );

    // Add agent as owner/maintainer
    await query(
      `INSERT INTO gitswarm_maintainers (repo_id, agent_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (repo_id, agent_id) DO NOTHING`,
      [repoResult.rows[0].id, agentId]
    );

    return reply.status(201).send({
      id: repoResult.rows[0].id,
      org_id: orgId,
      existing: false,
    });
  });

  // ============================================================
  // Server Updates Polling
  // ============================================================

  app.get('/gitswarm/updates', {
    preHandler: [authenticate],
  }, async (request) => {
    const { since, agent_id } = request.query;
    const agentId = agent_id || request.agent.id;
    const sinceDate = since || new Date(0).toISOString();

    // Fetch recent events relevant to this agent
    const tasks = await query(`
      SELECT t.id, t.title, t.status, t.priority, t.repo_id, t.created_at
      FROM gitswarm_tasks t
      JOIN gitswarm_repos r ON t.repo_id = r.id
      WHERE t.status = 'open' AND t.created_at > $1
      ORDER BY t.created_at DESC LIMIT 20
    `, [sinceDate]);

    const accessChanges = await query(`
      SELECT ra.repo_id, ra.access_level, ra.created_at
      FROM gitswarm_repo_access ra
      WHERE ra.agent_id = $1 AND ra.created_at > $2
      ORDER BY ra.created_at DESC LIMIT 20
    `, [agentId, sinceDate]);

    const proposals = await query(`
      SELECT cp.id, cp.title, cp.proposal_type, cp.status, cp.council_id, cp.proposed_at
      FROM gitswarm_council_proposals cp
      JOIN gitswarm_repo_councils rc ON cp.council_id = rc.id
      WHERE cp.status = 'open' AND cp.proposed_at > $1
      ORDER BY cp.proposed_at DESC LIMIT 20
    `, [sinceDate]);

    return {
      tasks: tasks.rows,
      access_changes: accessChanges.rows,
      proposals: proposals.rows,
      polled_at: new Date().toISOString(),
    };
  });
}

// ── Event Processors ──────────────────────────────────────────

async function processSyncEvent(type, data, agentId, { activityService, pluginEngine }) {
  switch (type) {
    case 'stream_created':
      await query(`
        INSERT INTO gitswarm_streams (id, repo_id, agent_id, name, branch, source, base_branch, parent_stream_id)
        VALUES ($1, $2, $3, $4, $5, 'cli', $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, gitswarm_streams.name),
          branch = COALESCE(EXCLUDED.branch, gitswarm_streams.branch),
          updated_at = NOW()
      `, [data.streamId || data.id, data.repoId, data.agent_id || agentId,
          data.name, data.branch, data.baseBranch || data.base_branch, data.parentStreamId || data.parent_stream_id]);
      break;

    case 'commit':
      await query(`
        INSERT INTO gitswarm_stream_commits (stream_id, agent_id, commit_hash, change_id, message)
        VALUES ($1, $2, $3, $4, $5)
      `, [data.streamId, agentId, data.commitHash || data.commit_hash, data.changeId || data.change_id, data.message]);
      break;

    case 'submit_review':
      await query(`
        UPDATE gitswarm_streams SET status = 'in_review', review_status = 'in_review', updated_at = NOW()
        WHERE id = $1
      `, [data.streamId]);
      break;

    case 'review':
      await query(`
        INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human, tested)
        VALUES ($1, $2, $3, $4, false, $5)
        ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
          verdict = $3, feedback = $4, tested = $5, reviewed_at = NOW()
      `, [data.streamId, agentId, data.verdict, data.feedback, data.tested || false]);
      break;

    case 'merge':
    case 'merge_requested':
      await query(`
        INSERT INTO gitswarm_merges (repo_id, stream_id, agent_id, merge_commit, target_branch)
        VALUES ($1, $2, $3, $4, $5)
      `, [data.repoId, data.streamId, agentId,
          data.mergeCommit || data.merge_commit, data.targetBranch || data.target_branch]);
      await query(`
        UPDATE gitswarm_streams SET status = 'merged', review_status = 'approved', updated_at = NOW()
        WHERE id = $1
      `, [data.streamId]);
      break;

    case 'stream_abandoned':
      await query(`
        UPDATE gitswarm_streams SET status = 'abandoned', updated_at = NOW()
        WHERE id = $1
      `, [data.streamId]);
      break;

    case 'stabilize': {
      await query(`
        INSERT INTO gitswarm_stabilizations (repo_id, result, tag, buffer_commit, breaking_stream_id, details)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [data.repoId, data.result, data.tag, data.bufferCommit || data.buffer_commit,
          data.breakingStreamId || data.breaking_stream_id, JSON.stringify(data.details || {})]);

      // Fire plugin engine for stabilization events
      if (pluginEngine) {
        const eventType = data.result === 'green' ? 'stabilization_passed' : 'stabilization_failed';
        pluginEngine.processGitswarmEvent(data.repoId, eventType, data)
          .catch(err => console.error(`Plugin event ${eventType} failed:`, err.message));
      }
      break;
    }

    case 'promote':
      await query(`
        INSERT INTO gitswarm_promotions (repo_id, from_commit, to_commit, triggered_by, agent_id)
        VALUES ($1, $2, $3, $4, $5)
      `, [data.repoId, data.fromCommit || data.from_commit,
          data.toCommit || data.to_commit, data.triggeredBy || data.triggered_by || 'manual', agentId]);
      break;

    case 'council_proposal':
      await query(`
        INSERT INTO gitswarm_council_proposals (council_id, title, description, proposal_type, proposed_by, action_data)
        VALUES (
          (SELECT id FROM gitswarm_repo_councils WHERE repo_id = $1),
          $2, $3, $4, $5, $6
        )
        ON CONFLICT DO NOTHING
      `, [data.repoId, data.proposal?.title, data.proposal?.description,
          data.proposal?.proposal_type, data.proposal?.proposed_by || agentId,
          JSON.stringify(data.proposal?.action_data || {})]);
      break;

    case 'council_vote':
      await query(`
        INSERT INTO gitswarm_council_votes (proposal_id, agent_id, vote, comment)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (proposal_id, agent_id) DO UPDATE SET vote = $3, comment = $4
      `, [data.proposalId, data.agent_id || agentId, data.vote, data.comment]);
      break;

    case 'stage_progression':
      await query(`
        INSERT INTO gitswarm_stage_history (repo_id, from_stage, to_stage, contributor_count, patch_count, maintainer_count)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [data.repoId, data.fromStage || data.from_stage, data.toStage || data.to_stage,
          data.metrics?.contributor_count, data.metrics?.patch_count, data.metrics?.maintainer_count]);
      await query(`
        UPDATE gitswarm_repos SET stage = $2, updated_at = NOW() WHERE id = $1
      `, [data.repoId, data.toStage || data.to_stage]);
      break;

    case 'task_submission':
      await query(`
        UPDATE gitswarm_task_claims SET status = 'submitted', submission_notes = $2, submitted_at = NOW()
        WHERE task_id = $1 AND agent_id = $3
      `, [data.taskId, data.notes || data.submission_notes, agentId]);
      break;

    default:
      throw new Error(`Unknown sync event type: ${type}`);
  }

  // Log activity for all synced events
  if (activityService) {
    activityService.logActivity({
      agent_id: agentId,
      event_type: `sync_${type}`,
      target_type: 'sync',
      target_id: data.streamId || data.repoId || '',
      metadata: { source: 'cli_sync', event_type: type },
    }).catch(() => {});
  }
}
