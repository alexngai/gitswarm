/**
 * GitSwarm MAP Event Taxonomy
 *
 * Defines all GitSwarm-specific events published through MAP's EventBus.
 * Events are scoped to repos (MAP scope = repo:{uuid}).
 *
 * This module provides typed event emission helpers used by routes and
 * services throughout the application.
 */

import type { MAPServer } from '@multi-agent-protocol/sdk/server';

// ============================================================
// Event type constants
// ============================================================

export const GITSWARM_EVENTS = {
  // Stream lifecycle
  STREAM_CREATED: 'gitswarm.stream.created',
  STREAM_UPDATED: 'gitswarm.stream.updated',
  STREAM_ABANDONED: 'gitswarm.stream.abandoned',

  // Reviews & consensus
  REVIEW_SUBMITTED: 'gitswarm.review.submitted',
  CONSENSUS_REACHED: 'gitswarm.consensus.reached',
  CONSENSUS_LOST: 'gitswarm.consensus.lost',

  // Merge
  MERGE_STARTED: 'gitswarm.merge.started',
  MERGE_COMPLETED: 'gitswarm.merge.completed',
  MERGE_FAILED: 'gitswarm.merge.failed',

  // Buffer lifecycle
  STABILIZATION_STARTED: 'gitswarm.stabilization.started',
  STABILIZATION_PASSED: 'gitswarm.stabilization.passed',
  STABILIZATION_FAILED: 'gitswarm.stabilization.failed',
  PROMOTION_COMPLETED: 'gitswarm.promotion.completed',

  // Governance
  COUNCIL_PROPOSAL_CREATED: 'gitswarm.council.proposal_created',
  COUNCIL_VOTE_CAST: 'gitswarm.council.vote_cast',
  COUNCIL_PROPOSAL_RESOLVED: 'gitswarm.council.proposal_resolved',

  // Tasks
  TASK_CREATED: 'gitswarm.task.created',
  TASK_CLAIMED: 'gitswarm.task.claimed',
  TASK_COMPLETED: 'gitswarm.task.completed',

  // Swarm
  SWARM_CREATED: 'gitswarm.swarm.created',

  // CI
  CI_COMPLETED: 'gitswarm.ci.completed',

  // Git push (from post-receive hook)
  GIT_PUSH: 'gitswarm.git.push',
} as const;

export type GitSwarmEventType = typeof GITSWARM_EVENTS[keyof typeof GITSWARM_EVENTS];

// ============================================================
// Event emission
// ============================================================

let _mapServer: MAPServer | null = null;

/**
 * Set the MAP server instance for event emission.
 * Called once during server initialization.
 */
export function setMapServer(server: MAPServer): void {
  _mapServer = server;
}

/**
 * Emit a GitSwarm event through MAP's EventBus.
 * Events are scoped to a repo so only agents subscribed to that repo receive them.
 *
 * @param eventType - One of GITSWARM_EVENTS constants
 * @param data - Event payload
 * @param repoId - Repository UUID (determines the MAP scope)
 * @param agentId - Optional: the agent that triggered the event
 */
export function emitGitSwarmEvent(
  eventType: string,
  data: Record<string, unknown>,
  repoId: string,
  agentId?: string
): void {
  if (!_mapServer) return;

  // Resolve the MAP scope ID from the repo UUID.
  // MAP subscription filtering uses scope IDs, not scope names.
  let scopeId: string | undefined;
  try {
    const scopeName = `repo:${repoId}`;
    const scopes = _mapServer.scopes?.list() || [];
    scopeId = scopes.find((s: any) => s.name === scopeName)?.id;
  } catch {
    // Scope resolution failed — emit without scope filtering
  }

  _mapServer.eventBus.emit({
    type: eventType,
    data: {
      ...data,
      repo_id: repoId,
      timestamp: new Date().toISOString(),
    },
    source: agentId ? { agentId } : undefined,
    scope: scopeId || undefined,
  });
}

/**
 * Emit a GitSwarm event without a repo scope (system-wide).
 */
export function emitSystemEvent(
  eventType: string,
  data: Record<string, unknown>,
  agentId?: string
): void {
  if (!_mapServer) return;

  _mapServer.eventBus.emit({
    type: eventType,
    data: {
      ...data,
      timestamp: new Date().toISOString(),
    },
    source: agentId ? { agentId } : undefined,
  });
}
