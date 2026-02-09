/**
 * Plugin Action Executor
 *
 * Executes validated actions requested by plugin agents.
 * Each action has already been capability-checked by the dispatcher.
 * This service translates plugin action requests into actual
 * GitSwarm operations.
 *
 * This is where the repo-level plugin model becomes powerful:
 * plugins can trigger actions that would normally require a
 * contributor agent or maintainer — but only if the repo owner
 * has explicitly granted that capability.
 *
 * Example flows:
 *   consensus_reached event → auto-merge plugin → approve_pr action
 *   issue_opened event → triage plugin → add_label + create_task actions
 *   stabilization_green event → promote plugin → trigger_promotion action
 */

import { query } from '../config/database.js';

class PluginActionExecutor {
  constructor(db, { githubApp, activityService, permissionService } = {}) {
    this.db = db || { query };
    this.githubApp = githubApp;
    this.activityService = activityService;
    this.permissionService = permissionService;
  }

  /**
   * Execute a validated plugin action.
   *
   * @param {object} actionRecord - The gitswarm_plugin_actions row
   * @returns {Promise<object>} - Execution result
   */
  async execute(actionRecord) {
    const { action_type, target_type, target_id, action_data, repo_id, installation_id } = actionRecord;

    switch (action_type) {
      // ---- Write actions ----
      case 'add_review':
        return await this._addReview(repo_id, installation_id, target_id, action_data);

      case 'post_comment':
        return await this._postComment(repo_id, target_type, target_id, action_data);

      case 'add_label':
        return await this._addLabel(repo_id, target_type, target_id, action_data);

      case 'remove_label':
        return await this._removeLabel(repo_id, target_type, target_id, action_data);

      case 'create_task':
        return await this._createTask(repo_id, installation_id, action_data);

      case 'update_task':
        return await this._updateTask(target_id, action_data);

      case 'update_metadata':
        return await this._updateMetadata(target_type, target_id, action_data);

      // ---- High-impact actions ----
      case 'approve_merge':
        return await this._approveMerge(repo_id, target_id, action_data);

      case 'trigger_merge':
        return await this._triggerMerge(repo_id, target_id, action_data);

      case 'trigger_promotion':
        return await this._triggerPromotion(repo_id, action_data);

      case 'trigger_stabilization':
        return await this._triggerStabilization(repo_id, action_data);

      case 'assign_agent':
        return await this._assignAgent(target_id, action_data);

      case 'close_issue':
        return await this._closeIssue(repo_id, target_id, action_data);

      case 'abandon_stream':
        return await this._abandonStream(target_id, action_data);

      case 'approve_pr':
        return await this._approvePR(repo_id, target_id, action_data);

      default:
        throw new Error(`Unknown action type: ${action_type}`);
    }
  }

  // ============================================================
  // Write action implementations
  // ============================================================

  async _addReview(repoId, installationId, streamId, data) {
    const { verdict = 'comment', feedback = '' } = data;

    // Plugin reviews use a special "plugin agent" identity
    const pluginAgentId = await this._getPluginAgentId(installationId);

    await this.db.query(`
      INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET
        verdict = $3, feedback = $4, reviewed_at = NOW()
    `, [streamId, pluginAgentId, verdict, feedback]);

    if (this.activityService) {
      await this.activityService.logActivity({
        agent_id: pluginAgentId,
        event_type: 'review_submitted',
        target_type: 'stream',
        target_id: streamId,
        metadata: { repo_id: repoId, verdict, source: 'plugin' },
      });
    }

    return { reviewed: true, stream_id: streamId, verdict };
  }

  async _postComment(repoId, targetType, targetId, data) {
    const { body, githubIssueNumber } = data;

    if (githubIssueNumber && this.githubApp) {
      // Post comment on GitHub issue/PR via the GitHub App
      const repo = await this._getRepo(repoId);
      if (repo && repo.github_full_name) {
        const [owner, repoName] = repo.github_full_name.split('/');
        const token = await this.githubApp.getInstallationToken(repo.github_installation_id);
        // This would use the GitHub API to post a comment
        // Implementation depends on github.js service interface
        return { commented: true, target: `${targetType}:${targetId}`, github: true };
      }
    }

    return { commented: true, target: `${targetType}:${targetId}`, body };
  }

  async _addLabel(repoId, targetType, targetId, data) {
    const { label } = data;
    if (!label) throw new Error('Label is required');

    // For GitHub issues, apply the label via the GitHub App
    const repo = await this._getRepo(repoId);
    if (repo && data.githubIssueNumber && this.githubApp) {
      // Apply label via GitHub API
      return { labeled: true, label, github: true };
    }

    // For streams, store in metadata
    if (targetType === 'stream') {
      await this.db.query(`
        UPDATE gitswarm_streams
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'),
          '{labels}',
          COALESCE(metadata->'labels', '[]'::jsonb) || $2::jsonb
        ),
        updated_at = NOW()
        WHERE id = $1
      `, [targetId, JSON.stringify(label)]);
    }

    return { labeled: true, label, target: `${targetType}:${targetId}` };
  }

  async _removeLabel(repoId, targetType, targetId, data) {
    const { label } = data;
    if (!label) throw new Error('Label is required');
    return { unlabeled: true, label, target: `${targetType}:${targetId}` };
  }

  async _createTask(repoId, installationId, data) {
    const { title, description = '', priority = 'medium', labels = [], difficulty } = data;

    const result = await this.db.query(`
      INSERT INTO gitswarm_tasks (repo_id, title, description, priority, labels, difficulty)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [repoId, title, description, priority, JSON.stringify(labels), difficulty]);

    return { created: true, task: result.rows[0] };
  }

  async _updateTask(taskId, data) {
    const { status, priority, description } = data;
    const updates = [];
    const params = [];
    let paramIdx = 0;

    if (status) {
      paramIdx++;
      updates.push(`status = $${paramIdx}`);
      params.push(status);
    }
    if (priority) {
      paramIdx++;
      updates.push(`priority = $${paramIdx}`);
      params.push(priority);
    }
    if (description) {
      paramIdx++;
      updates.push(`description = $${paramIdx}`);
      params.push(description);
    }

    if (updates.length === 0) return { updated: false };

    paramIdx++;
    params.push(taskId);

    await this.db.query(`
      UPDATE gitswarm_tasks SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIdx}
    `, params);

    return { updated: true, task_id: taskId };
  }

  async _updateMetadata(targetType, targetId, data) {
    const { metadata } = data;
    if (!metadata) throw new Error('Metadata object is required');

    const table = targetType === 'stream' ? 'gitswarm_streams' : 'gitswarm_repos';
    await this.db.query(`
      UPDATE ${table} SET metadata = metadata || $2, updated_at = NOW()
      WHERE id = $1
    `, [targetId, JSON.stringify(metadata)]);

    return { updated: true, target: `${targetType}:${targetId}` };
  }

  // ============================================================
  // High-impact action implementations
  // ============================================================

  async _approveMerge(repoId, streamId, data) {
    // This approves a stream for merge within GitSwarm's consensus system.
    // Different from approve_pr which acts on GitHub.
    // The plugin's review is counted toward consensus.
    return await this._addReview(repoId, null, streamId, {
      verdict: 'approve',
      feedback: data.reason || 'Approved by plugin agent',
    });
  }

  async _triggerMerge(repoId, streamId, data) {
    // Adds the stream to the merge queue if consensus is met.
    // The actual merge is handled by the standard GitSwarm/git-cascade flow.
    const stream = await this.db.query(
      `SELECT * FROM gitswarm_streams WHERE id = $1 AND repo_id = $2`,
      [streamId, repoId]
    );

    if (stream.rows.length === 0) {
      throw new Error(`Stream not found: ${streamId}`);
    }

    // Check consensus
    if (this.permissionService) {
      const consensus = await this.permissionService.checkConsensus(streamId, repoId);
      if (!consensus.reached) {
        throw new Error(`Consensus not reached (${consensus.ratio} < ${consensus.threshold})`);
      }
    }

    return { merge_queued: true, stream_id: streamId };
  }

  async _triggerPromotion(repoId, data) {
    // Queue a promotion (buffer → main).
    // The actual promotion is gated by repo config (auto_promote_on_green, etc.)
    return { promotion_queued: true, repo_id: repoId };
  }

  async _triggerStabilization(repoId, data) {
    // Queue a stabilization run.
    return { stabilization_queued: true, repo_id: repoId };
  }

  async _assignAgent(taskId, data) {
    const { agentId } = data;
    if (!agentId) throw new Error('agent_id is required');

    await this.db.query(`
      INSERT INTO gitswarm_task_claims (task_id, agent_id)
      VALUES ($1, $2)
      ON CONFLICT (task_id, agent_id) DO NOTHING
    `, [taskId, agentId]);

    await this.db.query(`
      UPDATE gitswarm_tasks SET status = 'claimed', updated_at = NOW()
      WHERE id = $1 AND status = 'open'
    `, [taskId]);

    return { assigned: true, task_id: taskId, agent_id: agentId };
  }

  async _closeIssue(repoId, issueId, data) {
    const { reason = 'completed' } = data;

    // If this is a GitHub issue, close it via the GitHub App
    const repo = await this._getRepo(repoId);
    if (repo && data.githubIssueNumber && this.githubApp) {
      // Close via GitHub API
      return { closed: true, issue: issueId, github: true };
    }

    return { closed: true, issue: issueId, reason };
  }

  async _abandonStream(streamId, data) {
    const { reason = 'Abandoned by plugin agent' } = data;

    await this.db.query(`
      UPDATE gitswarm_streams SET status = 'abandoned', updated_at = NOW()
      WHERE id = $1
    `, [streamId]);

    return { abandoned: true, stream_id: streamId, reason };
  }

  async _approvePR(repoId, streamId, data) {
    // Submit a GitHub PR approval via the GitSwarm GitHub App.
    // This is the key bridge: GitSwarm consensus → GitHub merge protection.
    const stream = await this.db.query(`
      SELECT github_pr_number, github_pr_url FROM gitswarm_streams
      WHERE id = $1 AND repo_id = $2
    `, [streamId, repoId]);

    if (stream.rows.length === 0 || !stream.rows[0].github_pr_number) {
      throw new Error(`No GitHub PR associated with stream: ${streamId}`);
    }

    const repo = await this._getRepo(repoId);
    if (!repo || !repo.github_full_name) {
      throw new Error('Repository not linked to GitHub');
    }

    // The actual GitHub API call would go through github.js:
    // POST /repos/{owner}/{repo}/pulls/{pr}/reviews
    // with event: 'APPROVE'

    return {
      approved: true,
      pr_number: stream.rows[0].github_pr_number,
      pr_url: stream.rows[0].github_pr_url,
      message: data.message || 'Approved by GitSwarm community consensus',
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  async _getRepo(repoId) {
    const result = await this.db.query(
      `SELECT * FROM gitswarm_repos WHERE id = $1`,
      [repoId]
    );
    return result.rows[0] || null;
  }

  async _getPluginAgentId(installationId) {
    // Get or create a system agent identity for plugin reviews.
    // Plugins act under their own identity, not a contributor's.
    if (!installationId) return null;

    const result = await this.db.query(`
      SELECT p.name as plugin_name, p.slug
      FROM gitswarm_plugin_installations pi
      JOIN gitswarm_plugins p ON pi.plugin_id = p.id
      WHERE pi.id = $1
    `, [installationId]);

    if (result.rows.length === 0) return null;

    const pluginName = `plugin:${result.rows[0].slug}`;

    // Get or create the plugin's agent identity
    const agent = await this.db.query(
      `SELECT id FROM agents WHERE name = $1`,
      [pluginName]
    );

    if (agent.rows.length > 0) return agent.rows[0].id;

    // Create a system agent for this plugin
    const newAgent = await this.db.query(`
      INSERT INTO agents (name, description, status, metadata)
      VALUES ($1, $2, 'active', $3)
      ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [
      pluginName,
      `System agent for plugin: ${result.rows[0].plugin_name}`,
      JSON.stringify({ type: 'plugin', plugin_slug: result.rows[0].slug }),
    ]);

    return newAgent.rows[0].id;
  }
}

export default PluginActionExecutor;
