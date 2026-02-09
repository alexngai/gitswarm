/**
 * File management routes for Mode C (server-managed worktrees).
 *
 * These endpoints allow stateless HTTP agents to read, write, and delete
 * files in server-managed worktrees without having git installed locally.
 *
 * All operations require the agent to have an active stream with a worktree
 * on the server, created via POST /repos/:id/streams with Mode C enabled.
 */

import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { gitCascadeManager } from '../../services/git-cascade-manager.js';

export async function fileRoutes(app, options = {}) {
  const { activityService } = options;

  const rateLimitRead = createRateLimiter('gitswarm_read');
  const rateLimitWrite = createRateLimiter('gitswarm_write');

  // ── Availability check ──────────────────────────────────────

  app.get('/gitswarm/mode-c/status', {
    preHandler: [authenticate, rateLimitRead],
  }, async () => {
    return {
      available: gitCascadeManager.isAvailable(),
      repos_dir: process.env.GITSWARM_REPOS_DIR || '/var/lib/gitswarm/repos',
    };
  });

  // ── Initialize repo for Mode C ──────────────────────────────

  app.post('/gitswarm/repos/:repoId/init-server', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          clone_url: { type: 'string' },
          buffer_branch: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = request.params;
    const { clone_url, buffer_branch } = request.body || {};

    if (!gitCascadeManager.isAvailable()) {
      return reply.status(503).send({
        error: 'Mode C unavailable',
        message: 'git-cascade and better-sqlite3 must be installed on the server',
      });
    }

    try {
      const result = await gitCascadeManager.initRepo(repoId, {
        cloneUrl: clone_url,
        bufferBranch: buffer_branch,
      });

      if (activityService) {
        await activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'repo_init_server',
          target_type: 'repo',
          target_id: repoId,
          metadata: { clone_url },
        });
      }

      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── File operations ─────────────────────────────────────────

  // Read file from agent's worktree
  app.get('/gitswarm/streams/:streamId/files/*', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { streamId } = request.params;
    const filePath = request.params['*'];
    const agentId = request.agent.id;

    // Resolve repo from stream
    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const content = await gitCascadeManager.readFile(repoId, agentId, filePath);
      if (content === null) {
        return reply.status(404).send({ error: 'File not found' });
      }
      return { path: filePath, content };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Write/update file in agent's worktree
  app.put('/gitswarm/streams/:streamId/files/*', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { streamId } = request.params;
    const filePath = request.params['*'];
    const agentId = request.agent.id;
    const { content } = request.body;

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const result = await gitCascadeManager.writeFile(repoId, agentId, filePath, content);

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'file_written',
          target_type: 'stream',
          target_id: streamId,
          metadata: { path: filePath, size: result.size },
        });
      }

      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Delete file from agent's worktree
  app.delete('/gitswarm/streams/:streamId/files/*', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { streamId } = request.params;
    const filePath = request.params['*'];
    const agentId = request.agent.id;

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const result = await gitCascadeManager.deleteFile(repoId, agentId, filePath);
      return result;
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // List files in agent's worktree
  app.get('/gitswarm/streams/:streamId/tree', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { streamId } = request.params;
    const agentId = request.agent.id;
    const dir = request.query.path || '.';

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const files = await gitCascadeManager.listFiles(repoId, agentId, dir);
      return { stream_id: streamId, path: dir, entries: files };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Server-side commit ──────────────────────────────────────

  // Commit staged files in agent's worktree (Mode C)
  app.post('/gitswarm/streams/:streamId/server-commit', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { streamId } = request.params;
    const agentId = request.agent.id;
    const { message } = request.body;

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const result = await gitCascadeManager.commitChanges(repoId, agentId, {
        message,
        streamId,
      });

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'commit',
          target_type: 'stream',
          target_id: streamId,
          metadata: { commit: result.commit, changeId: result.changeId },
        });
      }

      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Server-side merge ───────────────────────────────────────

  app.post('/gitswarm/streams/:streamId/server-merge', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { streamId } = request.params;

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const result = await gitCascadeManager.mergeToBuffer(repoId, streamId);

      if (activityService) {
        await activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'stream_merged',
          target_type: 'stream',
          target_id: streamId,
          metadata: { merge_commit: result.mergeCommit },
        });
      }

      return { success: true, ...result };
    } catch (err) {
      // Return structured conflict info instead of generic error
      if (err.message === 'merge_conflict' && err.conflicts) {
        return reply.status(409).send({
          error: 'merge_conflict',
          stream_id: streamId,
          conflicts: err.conflicts.map(c => ({
            path: c.path,
            ours: c.ours,
            theirs: c.theirs,
            base: c.base,
          })),
          resolution_url: `/api/v1/gitswarm/streams/${streamId}/resolve`,
        });
      }
      return reply.status(409).send({ error: err.message });
    }
  });

  // ── Conflict resolution ─────────────────────────────────────

  // Resolve merge conflicts by providing resolved file contents
  app.post('/gitswarm/streams/:streamId/resolve', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['resolutions'],
        properties: {
          resolutions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'content'],
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { streamId } = request.params;
    const { resolutions } = request.body;

    const repoId = await _resolveRepoForStream(streamId);
    if (!repoId) return reply.status(404).send({ error: 'Stream not found' });

    try {
      const result = await gitCascadeManager.resolveConflict(repoId, streamId, resolutions);

      if (activityService) {
        await activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'stream_merged',
          target_type: 'stream',
          target_id: streamId,
          metadata: {
            merge_commit: result.mergeCommit,
            conflict_resolved: true,
            resolved_files: resolutions.map(r => r.path),
          },
        });
      }

      return { success: true, ...result };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Server-side stabilize ───────────────────────────────────
  // Stabilization runs are performed by external agents, not the server.
  // Agents pull the buffer branch, run tests, and report results here.

  // Get current buffer state (so agents know what to stabilize against)
  app.get('/gitswarm/repos/:repoId/buffer-state', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId } = request.params;

    if (!gitCascadeManager.isAvailable()) {
      return reply.status(503).send({ error: 'Mode C unavailable' });
    }

    try {
      const state = await gitCascadeManager.getBufferState(repoId);
      return {
        buffer_branch: state.bufferBranch,
        buffer_commit: state.bufferCommit,
      };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Report stabilization result from an external agent run
  app.post('/gitswarm/repos/:repoId/server-stabilize', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        required: ['result', 'buffer_commit'],
        properties: {
          result: { type: 'string', enum: ['green', 'red'] },
          buffer_commit: { type: 'string' },
          breaking_stream_id: { type: 'string' },
          output: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = request.params;
    const agentId = request.agent.id;
    const {
      result: stabResult,
      buffer_commit,
      breaking_stream_id,
      output,
      details = {},
    } = request.body;

    try {
      // Record stabilization in governance DB
      const insertResult = await dbQuery(`
        INSERT INTO gitswarm_stabilizations (
          repo_id, result, buffer_commit, breaking_stream_id, details
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [repoId, stabResult, buffer_commit, breaking_stream_id,
          JSON.stringify({ ...details, output: output?.slice(0, 10000) })]);

      // If red and auto_revert_on_red, mark the breaking stream
      if (stabResult === 'red' && breaking_stream_id) {
        const repo = await dbQuery(`
          SELECT auto_revert_on_red FROM gitswarm_repos WHERE id = $1
        `, [repoId]);

        if (repo.rows[0]?.auto_revert_on_red) {
          await dbQuery(`
            UPDATE gitswarm_streams SET status = 'reverted', updated_at = NOW()
            WHERE id = $1
          `, [breaking_stream_id]);
        }
      }

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'stabilization',
          target_type: 'repo',
          target_id: repoId,
          metadata: { result: stabResult, buffer_commit, breaking_stream_id },
        });
      }

      return reply.status(201).send({ stabilization: insertResult.rows[0] });
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Server-side promote ─────────────────────────────────────

  app.post('/gitswarm/repos/:repoId/server-promote', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId } = request.params;

    try {
      const result = await gitCascadeManager.promote(repoId);

      if (activityService) {
        await activityService.logActivity({
          agent_id: request.agent.id,
          event_type: 'promote',
          target_type: 'repo',
          target_id: repoId,
          metadata: result,
        });
      }

      return { success: true, ...result };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────

import { query as dbQuery } from '../../config/database.js';

async function _resolveRepoForStream(streamId) {
  const result = await dbQuery(`
    SELECT repo_id FROM gitswarm_streams WHERE id = $1
  `, [streamId]);
  return result.rows[0]?.repo_id || null;
}
