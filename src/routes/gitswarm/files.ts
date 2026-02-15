/**
 * File management routes for Mode C (server-managed worktrees).
 *
 * These endpoints allow stateless HTTP agents to read, write, and delete
 * files in server-managed worktrees without having git installed locally.
 *
 * All operations require the agent to have an active stream with a worktree
 * on the server, created via POST /repos/:id/streams with Mode C enabled.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { gitCascadeManager } from '../../services/git-cascade-manager.js';
import { GitSwarmPermissionService } from '../../services/gitswarm-permissions.js';

const permissionService = new GitSwarmPermissionService();

export async function fileRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
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
    const { repoId } = (request.params as any);
    const { clone_url, buffer_branch } = (request.body as any) || {};

    // Only maintainers/owners can initialize server-side repos
    const perm = await permissionService.canPerform(request.agent.id, repoId, 'merge');
    if (!perm.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only maintainers can initialize server repos' });
    }

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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Mode C stream (workspace) creation ─────────────────────

  // Create a stream and worktree on the server for a stateless agent
  app.post('/gitswarm/repos/:repoId/server-streams', {
    preHandler: [authenticate, rateLimitWrite],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          base_branch: { type: 'string' },
          parent_stream_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { repoId } = (request.params as any);
    const agentId = request.agent.id;
    const { name, base_branch, parent_stream_id } = (request.body as any) || {};

    if (!gitCascadeManager.isAvailable()) {
      return reply.status(503).send({ error: 'Mode C unavailable' });
    }

    // Check write permission
    const perm = await permissionService.canPerform(agentId, repoId, 'write');
    if (!perm.allowed) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    try {
      const result = await gitCascadeManager.createStream(repoId, {
        agentId,
        name,
        baseBranch: base_branch,
        parentStreamId: parent_stream_id,
      });

      // Record the stream in governance DB
      await dbQuery(`
        INSERT INTO gitswarm_streams (id, repo_id, agent_id, name, branch, source, base_branch, parent_stream_id)
        VALUES ($1, $2, $3, $4, $5, 'api', $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [result.streamId, repoId, agentId, name || result.streamId,
          result.branch, base_branch || 'buffer', parent_stream_id]);

      if (activityService) {
        await activityService.logActivity({
          agent_id: agentId,
          event_type: 'stream_created',
          target_type: 'stream',
          target_id: result.streamId,
          metadata: { repo_id: repoId, mode: 'server' },
        });
      }

      return reply.status(201).send(result);
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── File operations ─────────────────────────────────────────

  // Read file from agent's worktree
  app.get('/gitswarm/streams/:streamId/files/*', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { streamId } = (request.params as any);
    const filePath = _validateFilePath((request.params as any)['*']);
    if (!filePath) return reply.status(400).send({ error: 'Invalid file path' });

    const auth = await _authorizeStreamAccess(streamId, request.agent.id);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Forbidden' });

    try {
      const content = await gitCascadeManager.readFile(auth.repoId, auth.ownerId, filePath);
      if (content === null) {
        return reply.status(404).send({ error: 'File not found' });
      }
      return { path: filePath, content };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
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
    const { streamId } = (request.params as any);
    const filePath = _validateFilePath((request.params as any)['*']);
    if (!filePath) return reply.status(400).send({ error: 'Invalid file path' });
    const agentId = request.agent.id;
    const { content } = (request.body as any);

    // Only stream owner can write
    const auth = await _authorizeStreamAccess(streamId, agentId, true);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Only stream owner can write files' });
    if (auth.status !== 'active') return reply.status(409).send({ error: 'Stream is not active' });

    try {
      const result = await gitCascadeManager.writeFile(auth.repoId, agentId, filePath, content);

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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Delete file from agent's worktree
  app.delete('/gitswarm/streams/:streamId/files/*', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { streamId } = (request.params as any);
    const filePath = _validateFilePath((request.params as any)['*']);
    if (!filePath) return reply.status(400).send({ error: 'Invalid file path' });
    const agentId = request.agent.id;

    // Only stream owner can delete
    const auth = await _authorizeStreamAccess(streamId, agentId, true);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Only stream owner can delete files' });
    if (auth.status !== 'active') return reply.status(409).send({ error: 'Stream is not active' });

    try {
      const result = await gitCascadeManager.deleteFile(auth.repoId, agentId, filePath);
      return result;
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // List files in agent's worktree
  app.get('/gitswarm/streams/:streamId/tree', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { streamId } = (request.params as any);
    const dir = _validateFilePath((request.query as any).path || '.') || '.';

    const auth = await _authorizeStreamAccess(streamId, request.agent.id);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Forbidden' });

    try {
      const files = await gitCascadeManager.listFiles(auth.repoId, auth.ownerId, dir);
      return { stream_id: streamId, path: dir, entries: files };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
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
    const { streamId } = (request.params as any);
    const agentId = request.agent.id;
    const { message } = (request.body as any);

    // Only stream owner can commit
    const auth = await _authorizeStreamAccess(streamId, agentId, true);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Only stream owner can commit' });
    if (auth.status !== 'active') return reply.status(409).send({ error: 'Stream is not active' });

    try {
      const result = await gitCascadeManager.commitChanges(auth.repoId, agentId, {
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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Server-side merge ───────────────────────────────────────

  app.post('/gitswarm/streams/:streamId/server-merge', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { streamId } = (request.params as any);

    // Stream owner or maintainer can merge
    const auth = await _authorizeStreamAccess(streamId, request.agent.id);
    if (!auth) return reply.status(404).send({ error: 'Stream not found' });
    if (!auth.allowed) return reply.status(403).send({ error: 'Forbidden' });
    const repoId = auth.repoId;

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
    } catch (err: unknown) {
      // Return structured conflict info instead of generic error
      if ((err as any).message === 'merge_conflict' && (err as any).conflicts) {
        return reply.status(409).send({
          error: 'merge_conflict',
          stream_id: streamId,
          conflicts: (err as any).conflicts.map((c: any) => ({
            path: c.path,
            ours: c.ours,
            theirs: c.theirs,
            base: c.base,
          })),
          resolution_url: `/api/v1/gitswarm/streams/${streamId}/resolve`,
        });
      }
      return reply.status(409).send({ error: (err as Error).message });
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
    const { streamId } = (request.params as any);
    const { resolutions } = (request.body as any);

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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Server-side stabilize ───────────────────────────────────
  // Stabilization runs are performed by external agents, not the server.
  // Agents pull the buffer branch, run tests, and report results here.

  // Get current buffer state (so agents know what to stabilize against)
  app.get('/gitswarm/repos/:repoId/buffer-state', {
    preHandler: [authenticate, rateLimitRead],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

    if (!gitCascadeManager.isAvailable()) {
      return reply.status(503).send({ error: 'Mode C unavailable' });
    }

    try {
      const state = await gitCascadeManager.getBufferState(repoId);
      return {
        buffer_branch: state.bufferBranch,
        buffer_commit: state.bufferCommit,
      };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
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
    const { repoId } = (request.params as any);
    const agentId = request.agent.id;
    const {
      result: stabResult,
      buffer_commit,
      breaking_stream_id,
      output,
      details = {},
    } = (request.body as any);

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

          // Also update git-cascade tracker if available
          try {
            const ctx = await gitCascadeManager.getTracker(repoId);
            if (ctx?.tracker) {
              (ctx.tracker as any).updateStream(breaking_stream_id, { status: 'reverted' });
            }
          } catch {
            // Non-critical: cascade state will reconcile on next operation
          }
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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Server-side promote ─────────────────────────────────────

  app.post('/gitswarm/repos/:repoId/server-promote', {
    preHandler: [authenticate, rateLimitWrite],
  }, async (request, reply) => {
    const { repoId } = (request.params as any);

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
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────

import { join, resolve, normalize } from 'path';
import { query as dbQuery } from '../../config/database.js';

async function _resolveRepoForStream(streamId: string): Promise<string | null> {
  const result = await dbQuery(`
    SELECT repo_id FROM gitswarm_streams WHERE id = $1
  `, [streamId]);
  return result.rows[0]?.repo_id || null;
}

/**
 * Verify agent owns or has maintainer access to the stream.
 * Returns { allowed, repoId, agentId: streamOwner } or null if stream not found.
 */
async function _authorizeStreamAccess(streamId: string, requestAgentId: string, requireOwner: boolean = false): Promise<{ allowed: boolean; repoId: string; ownerId: string; status: string } | null> {
  const result = await dbQuery(`
    SELECT s.repo_id, s.agent_id, s.status
    FROM gitswarm_streams s
    WHERE s.id = $1
  `, [streamId]);

  if (result.rows.length === 0) return null;

  const { repo_id, agent_id, status } = result.rows[0];

  // Stream owner always has access
  if (agent_id === requestAgentId) {
    return { allowed: true, repoId: repo_id, ownerId: agent_id, status };
  }

  // For read operations, check repo read access
  if (!requireOwner) {
    const perm = await permissionService.canPerform(requestAgentId, repo_id, 'read');
    if (perm.allowed) {
      return { allowed: true, repoId: repo_id, ownerId: agent_id, status };
    }
  }

  return { allowed: false, repoId: repo_id, ownerId: agent_id, status };
}

/**
 * Validate a file path to prevent directory traversal attacks.
 * Returns the sanitized path or null if invalid.
 */
function _validateFilePath(filePath: string | undefined): string | null {
  if (!filePath || typeof filePath !== 'string') return null;

  // Normalize and check for traversal
  const normalized = normalize(filePath);
  if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('..')) {
    return null;
  }

  // Block access to .git internals
  if (normalized === '.git' || normalized.startsWith('.git/') || normalized.startsWith('.git\\')) {
    return null;
  }

  return normalized;
}
