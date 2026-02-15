/**
 * Shared type definitions for GitSwarm.
 *
 * Used across backend (src/), CLI (cli/), and shared (shared/) modules.
 */

// ── Database query interface ─────────────────────────────────

/** Result of a database query (compatible with both pg and SQLite adapter). */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number;
}

/** A function that executes a parameterized SQL query. */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** A function that resolves a logical table name to an actual table name. */
export type TableResolver = (name: string) => string;

// ── Table name maps ──────────────────────────────────────────

export interface TableMap {
  agents: string;
  repos: string;
  orgs: string;
  repo_access: string;
  maintainers: string;
  branch_rules: string;
  stream_reviews: string;
  streams: string;
  stream_commits: string;
  stage_history: string;
  repo_councils: string;
  merges: string;
  stabilizations: string;
  promotions: string;
  tasks: string;
  task_claims: string;
}

// ── Service constructor options ──────────────────────────────

export interface ServiceOptions {
  query: QueryFn;
  t?: TableResolver;
}

// ── Agent ────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  bio?: string | null;
  avatar_url?: string | null;
  karma: number;
  status: string;
  description?: string | null;
  api_key_hash?: string;
  created_at: string;
  updated_at?: string;
}

// ── Repository ───────────────────────────────────────────────

export type OwnershipModel = 'solo' | 'guild' | 'open';
export type MergeMode = 'swarm' | 'review' | 'gated';
export type AgentAccess = 'public' | 'karma_threshold' | 'allowlist' | 'none';
export type Stage = 'seed' | 'growth' | 'established' | 'mature';

export interface Repository {
  id: string;
  name?: string;
  stage: Stage;
  ownership_model: OwnershipModel;
  merge_mode: MergeMode;
  agent_access: AgentAccess;
  consensus_threshold: number;
  min_reviews: number;
  min_karma?: number;
  is_private?: boolean;
  buffer_branch?: string;
  promote_target?: string;
  stabilize_command?: string;
  contributor_count?: number;
  patch_count?: number;
  status?: string;
  plugins_enabled?: boolean;
  human_review_weight?: number;
  created_at?: string;
  updated_at?: string;
}

// ── Streams ──────────────────────────────────────────────────

export type StreamStatus = 'open' | 'review' | 'merged' | 'abandoned';

export interface Stream {
  id: string;
  name?: string;
  repo_id: string;
  agent_id: string;
  status: StreamStatus;
  base_commit?: string;
  parent_stream?: string;
  created_at?: string;
  updated_at?: string;
}

// ── Reviews ──────────────────────────────────────────────────

export type ReviewVerdict = 'approve' | 'request_changes';

export interface StreamReview {
  id?: string;
  stream_id: string;
  reviewer_id: string;
  reviewer_name?: string;
  verdict: ReviewVerdict;
  feedback?: string;
  tested?: boolean;
  is_human?: boolean;
  is_maintainer?: boolean;
  karma?: number;
  reviewed_at?: string;
}

// ── Tasks ────────────────────────────────────────────────────

export type TaskStatus = 'open' | 'claimed' | 'submitted' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  repo_id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  amount?: number;
  difficulty?: string;
  creator_id?: string;
  creator_name?: string;
  active_claims?: number;
  created_at?: string;
}

export interface TaskClaim {
  id: string;
  task_id: string;
  agent_id: string;
  stream_id?: string;
  status: string;
  notes?: string;
  created_at?: string;
}

// ── Council / Governance ─────────────────────────────────────

export interface Council {
  id: string;
  repo_id: string;
  status: string;
  min_karma?: number;
  min_contributions?: number;
  min_members: number;
  max_members: number;
  standard_quorum: number;
  critical_quorum: number;
  created_at?: string;
}

export interface CouncilMember {
  id?: string;
  council_id: string;
  agent_id: string;
  agent_name?: string;
  role: string;
  karma?: number;
  votes_cast?: number;
  joined_at?: string;
}

export interface Proposal {
  id: string;
  council_id: string;
  proposer_id: string;
  proposer_name?: string;
  title: string;
  description?: string;
  proposal_type: string;
  action_data?: Record<string, unknown>;
  status: string;
  quorum_required: number;
  votes_for: number;
  votes_against: number;
  created_at?: string;
  expires_at?: string;
}

// ── Permissions ──────────────────────────────────────────────

export type AccessLevel = 'none' | 'read' | 'write' | 'maintain' | 'admin';
export type PermissionAction = 'read' | 'write' | 'merge' | 'settings' | 'delete';

export interface PermissionResult {
  level: AccessLevel;
  source: string;
  role?: string;
  threshold?: number;
  karma?: number;
}

export interface ConsensusResult {
  reached: boolean;
  reason: string;
  ratio?: number;
  threshold?: number;
  approvals?: number;
  rejections?: number;
  maintainer_approvals?: number;
  maintainer_rejections?: number;
  approval_weight?: number;
  rejection_weight?: number;
  current?: number;
  required?: number;
}

export interface BranchPushResult {
  allowed: boolean;
  reason: string;
  permissions?: PermissionResult;
  rule?: Record<string, unknown>;
}

// ── Stage progression ────────────────────────────────────────

export interface StageThresholds {
  min_contributors: number;
  min_patches: number;
  min_maintainers: number;
  has_council?: boolean;
}

export interface StageMetrics {
  contributor_count: number;
  patch_count: number;
  maintainer_count: number;
  has_council: boolean;
}

export interface StageAdvancementResult {
  eligible: boolean;
  current_stage: Stage;
  next_stage: Stage | null;
  requirements?: StageThresholds;
  metrics?: StageMetrics;
  unmet_requirements?: Array<{
    requirement: string;
    required: number | boolean;
    current: number | boolean;
  }>;
  reason?: string;
}

// ── Activity events ──────────────────────────────────────────

export interface ActivityEvent {
  agent_id?: string;
  event_type: string;
  target_type?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityRecord extends ActivityEvent {
  id?: string;
  agent_name?: string;
  timestamp?: string;
  category?: string;
}

// ── Config ───────────────────────────────────────────────────

export interface FederationConfig {
  name?: string;
  merge_mode?: MergeMode;
  ownership_model?: OwnershipModel;
  agent_access?: AgentAccess;
  consensus_threshold?: number;
  min_reviews?: number;
  buffer_branch?: string;
  promote_target?: string;
  stabilize_command?: string;
  [key: string]: unknown;
}

// ── Rate limiting ────────────────────────────────────────────

export interface RateLimit {
  max: number;
  window: number;
}

export interface KarmaTier {
  minKarma: number;
  multiplier: number;
  name: string;
}

// ── Fastify augmentation ─────────────────────────────────────

import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
    startTime?: bigint;
    requestId?: string;
    humanUser?: {
      id: string;
      role: string;
      github_login?: string;
    };
  }
}

export type { FastifyRequest, FastifyReply };

// ── WebSocket ────────────────────────────────────────────────

export interface WebSocketMessage {
  type: string;
  data: Record<string, unknown>;
}

// ── Plugin types ─────────────────────────────────────────────

export interface PluginDefinition {
  name: string;
  tier: number;
  events: string[];
  description?: string;
  handler?: (event: Record<string, unknown>) => Promise<void> | void;
}
