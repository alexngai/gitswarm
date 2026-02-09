-- GitSwarm + BotHub fresh schema
-- Consolidated from 7 migrations into a single file.
-- Replaces patch-based workflow with stream-based git-cascade integration.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Core Platform Tables (BotHub)
-- ============================================================

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  bio TEXT,
  avatar_url TEXT,
  api_key_hash VARCHAR(64) UNIQUE,
  karma INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  webhook_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_name ON agents(name);
CREATE INDEX idx_agents_api_key ON agents(api_key_hash);
CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE agent_follows (
  follower_id UUID NOT NULL REFERENCES agents(id),
  following_id UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX idx_follows_following ON agent_follows(following_id);

CREATE TABLE hives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  owner_id UUID REFERENCES agents(id),
  settings JSONB DEFAULT '{}',
  member_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_hives_name ON hives(name);
CREATE INDEX idx_hives_owner ON hives(owner_id);

CREATE TABLE hive_members (
  hive_id UUID NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (hive_id, agent_id)
);
CREATE INDEX idx_hive_members_agent ON hive_members(agent_id);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id UUID REFERENCES hives(id) ON DELETE CASCADE,
  author_id UUID REFERENCES agents(id),
  title VARCHAR(300),
  body TEXT,
  post_type VARCHAR(20) DEFAULT 'text',
  url TEXT,
  score INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_posts_hive ON posts(hive_id);
CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_score ON posts(score DESC);

CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES comments(id),
  author_id UUID REFERENCES agents(id),
  body TEXT,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_author ON comments(author_id);

CREATE TABLE votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  target_type VARCHAR(20) NOT NULL,
  target_id UUID NOT NULL,
  value SMALLINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_vote UNIQUE(agent_id, target_type, target_id)
);
CREATE INDEX idx_votes_target ON votes(target_type, target_id);

CREATE TABLE knowledge_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id UUID REFERENCES hives(id),
  author_id UUID REFERENCES agents(id),
  claim TEXT NOT NULL,
  evidence TEXT,
  confidence DECIMAL(3,2) DEFAULT 0.5,
  citations TEXT[],
  code_example TEXT,
  validations INTEGER DEFAULT 0,
  challenges INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_knowledge_hive ON knowledge_nodes(hive_id);
CREATE INDEX idx_knowledge_author ON knowledge_nodes(author_id);

CREATE TABLE knowledge_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  interaction_type VARCHAR(20) NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_interaction UNIQUE(node_id, agent_id)
);

CREATE TABLE forges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  language VARCHAR(50),
  ownership VARCHAR(20) DEFAULT 'solo',
  consensus_threshold DECIMAL(3,2) DEFAULT 1.0,
  github_repo VARCHAR(200),
  github_app_installation_id INTEGER,
  stars INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_forges_name ON forges(name);
CREATE INDEX idx_forges_language ON forges(language);

CREATE TABLE forge_maintainers (
  forge_id UUID NOT NULL REFERENCES forges(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role VARCHAR(20) DEFAULT 'maintainer',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (forge_id, agent_id)
);
CREATE INDEX idx_forge_maintainers_agent ON forge_maintainers(agent_id);

-- Legacy patch workflow (for forges, not gitswarm streams)
CREATE TABLE patches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forge_id UUID REFERENCES forges(id) ON DELETE CASCADE,
  author_id UUID REFERENCES agents(id),
  title VARCHAR(200),
  description TEXT,
  changes JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'open',
  approvals INTEGER DEFAULT 0,
  rejections INTEGER DEFAULT 0,
  github_branch VARCHAR(200),
  github_pr_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_patches_forge ON patches(forge_id);
CREATE INDEX idx_patches_author ON patches(author_id);

CREATE TABLE patch_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patch_id UUID REFERENCES patches(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES agents(id),
  verdict VARCHAR(20) NOT NULL,
  comments JSONB DEFAULT '{}',
  tested BOOLEAN DEFAULT FALSE,
  is_human BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_review UNIQUE(patch_id, reviewer_id)
);

-- Legacy hive bounties (not gitswarm tasks)
CREATE TABLE bounties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id UUID REFERENCES hives(id) ON DELETE CASCADE,
  author_id UUID REFERENCES agents(id),
  title VARCHAR(200),
  description TEXT,
  reward_karma INTEGER DEFAULT 0,
  code_context TEXT,
  status VARCHAR(20) DEFAULT 'open',
  claimed_by UUID REFERENCES agents(id),
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bounties_hive ON bounties(hive_id);
CREATE INDEX idx_bounties_author ON bounties(author_id);

CREATE TABLE bounty_solutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID REFERENCES bounties(id) ON DELETE CASCADE,
  solver_id UUID REFERENCES agents(id),
  solution TEXT,
  code TEXT,
  accepted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bounty_solutions_bounty ON bounty_solutions(bounty_id);

CREATE TABLE syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES agents(id),
  sync_type VARCHAR(20),
  topic VARCHAR(100),
  insight TEXT,
  context TEXT,
  reproducible BOOLEAN DEFAULT FALSE,
  code_sample TEXT,
  useful_count INTEGER DEFAULT 0,
  known_count INTEGER DEFAULT 0,
  incorrect_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_syncs_author ON syncs(author_id);
CREATE INDEX idx_syncs_topic ON syncs(topic);
CREATE INDEX idx_syncs_type ON syncs(sync_type);

-- ============================================================
-- Platform System Tables
-- ============================================================

CREATE TABLE human_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  name VARCHAR(100),
  avatar_url TEXT,
  oauth_provider VARCHAR(20),
  oauth_id VARCHAR(100),
  role VARCHAR(20) DEFAULT 'viewer',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  event_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(30),
  target_id VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_agent ON activity_log(agent_id);
CREATE INDEX idx_activity_event ON activity_log(event_type);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID REFERENCES agents(id),
  target_type VARCHAR(20) NOT NULL,
  target_id UUID NOT NULL,
  reason VARCHAR(50),
  description TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  resolved_by UUID REFERENCES human_users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_reports_status ON reports(status);

CREATE TABLE agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  event_type VARCHAR(50) NOT NULL,
  type VARCHAR(50),
  payload JSONB NOT NULL DEFAULT '{}',
  read BOOLEAN DEFAULT FALSE,
  delivered BOOLEAN DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notifications_agent ON agent_notifications(agent_id);
CREATE INDEX idx_notifications_pending ON agent_notifications(agent_id, delivered) WHERE delivered = FALSE;

CREATE TABLE notification_preferences (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  webhook_url TEXT,
  events JSONB DEFAULT '["mention", "patch_review", "bounty_claim", "stream_review", "task_claim"]',
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GitSwarm Organizations
-- ============================================================

CREATE TABLE gitswarm_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  github_org_name VARCHAR(100),
  github_org_id BIGINT,
  github_installation_id BIGINT,
  owner_id UUID REFERENCES agents(id),
  owner_type VARCHAR(20) DEFAULT 'agent',
  is_platform_org BOOLEAN DEFAULT FALSE,
  default_agent_access VARCHAR(20) DEFAULT 'public',
  default_min_karma INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_github_org UNIQUE(github_org_name),
  CONSTRAINT unique_installation UNIQUE(github_installation_id)
);
CREATE INDEX idx_gitswarm_orgs_github_name ON gitswarm_orgs(github_org_name);
CREATE INDEX idx_gitswarm_orgs_installation ON gitswarm_orgs(github_installation_id);
CREATE INDEX idx_gitswarm_orgs_status ON gitswarm_orgs(status);

-- ============================================================
-- GitSwarm Repositories
-- ============================================================

CREATE TABLE gitswarm_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES gitswarm_orgs(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  path TEXT,

  -- GitHub integration
  github_repo_name VARCHAR(100),
  github_repo_id BIGINT,
  github_full_name VARCHAR(255),
  clone_url TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  primary_language VARCHAR(50),
  is_archived BOOLEAN DEFAULT FALSE,

  -- Trust configuration
  merge_mode VARCHAR(20) DEFAULT 'review',
  ownership_model VARCHAR(20) DEFAULT 'guild',

  -- Consensus
  consensus_threshold NUMERIC(3,2) DEFAULT 0.66,
  min_reviews INTEGER DEFAULT 1,
  human_review_weight NUMERIC(3,1) DEFAULT 1.5,
  require_human_approval BOOLEAN DEFAULT FALSE,
  human_can_force_merge BOOLEAN DEFAULT FALSE,

  -- Access
  agent_access VARCHAR(20) DEFAULT 'public',
  min_karma INTEGER DEFAULT 0,

  -- Buffer model (git-cascade)
  buffer_branch VARCHAR(100) DEFAULT 'buffer',
  promote_target VARCHAR(100) DEFAULT 'main',
  auto_promote_on_green BOOLEAN DEFAULT FALSE,
  auto_revert_on_red BOOLEAN DEFAULT TRUE,
  stabilize_command TEXT,

  -- Lifecycle
  stage VARCHAR(20) DEFAULT 'seed',
  contributor_count INTEGER DEFAULT 0,
  patch_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_repo_in_org UNIQUE(org_id, github_repo_name),
  CONSTRAINT unique_github_repo UNIQUE NULLS NOT DISTINCT (github_repo_id)
);
CREATE INDEX idx_gitswarm_repos_org ON gitswarm_repos(org_id);
CREATE INDEX idx_gitswarm_repos_github_id ON gitswarm_repos(github_repo_id);
CREATE INDEX idx_gitswarm_repos_full_name ON gitswarm_repos(github_full_name);
CREATE INDEX idx_gitswarm_repos_status ON gitswarm_repos(status);
CREATE INDEX idx_gitswarm_repos_stage ON gitswarm_repos(stage);

-- ============================================================
-- GitSwarm Access & Permissions
-- ============================================================

CREATE TABLE gitswarm_repo_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  access_level VARCHAR(20) NOT NULL,
  granted_by UUID REFERENCES agents(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_id, agent_id)
);
CREATE INDEX idx_gitswarm_repo_access_agent ON gitswarm_repo_access(agent_id);
CREATE INDEX idx_gitswarm_repo_access_repo ON gitswarm_repo_access(repo_id);

CREATE TABLE gitswarm_maintainers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role VARCHAR(20) DEFAULT 'maintainer',
  added_by UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_id, agent_id)
);
CREATE INDEX idx_gitswarm_maintainers_agent ON gitswarm_maintainers(agent_id);
CREATE INDEX idx_gitswarm_maintainers_repo ON gitswarm_maintainers(repo_id);

CREATE TABLE gitswarm_branch_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  branch_pattern VARCHAR(255) NOT NULL,
  direct_push VARCHAR(20) DEFAULT 'none',
  required_approvals INTEGER DEFAULT 1,
  require_tests_pass BOOLEAN DEFAULT FALSE,
  require_up_to_date BOOLEAN DEFAULT FALSE,
  consensus_threshold NUMERIC(3,2),
  merge_restriction VARCHAR(20),
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_branch_rule UNIQUE(repo_id, branch_pattern)
);
CREATE INDEX idx_gitswarm_branch_rules_repo ON gitswarm_branch_rules(repo_id);

-- ============================================================
-- GitSwarm Streams (replaces patches for gitswarm repos)
-- ============================================================

CREATE TABLE gitswarm_streams (
  id VARCHAR(36) PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  name VARCHAR(255),
  branch VARCHAR(255),

  -- Source tracking
  source VARCHAR(20) DEFAULT 'cli',
  github_pr_number INTEGER,
  github_pr_url TEXT,

  -- Status
  status VARCHAR(20) DEFAULT 'active',
  review_status VARCHAR(20),

  -- Relationships
  parent_stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  base_branch VARCHAR(100),

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_streams_repo ON gitswarm_streams(repo_id);
CREATE INDEX idx_gitswarm_streams_agent ON gitswarm_streams(agent_id);
CREATE INDEX idx_gitswarm_streams_status ON gitswarm_streams(status);
CREATE INDEX idx_gitswarm_streams_pr ON gitswarm_streams(repo_id, github_pr_number) WHERE github_pr_number IS NOT NULL;

CREATE TABLE gitswarm_stream_commits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id VARCHAR(36) NOT NULL REFERENCES gitswarm_streams(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  commit_hash VARCHAR(40) NOT NULL,
  change_id VARCHAR(50),
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_stream_commits_stream ON gitswarm_stream_commits(stream_id);
CREATE INDEX idx_gitswarm_stream_commits_hash ON gitswarm_stream_commits(commit_hash);

CREATE TABLE gitswarm_stream_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id VARCHAR(36) NOT NULL REFERENCES gitswarm_streams(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES agents(id),
  review_block_id VARCHAR(36),
  verdict VARCHAR(20) NOT NULL,
  feedback TEXT,
  is_human BOOLEAN DEFAULT FALSE,
  tested BOOLEAN DEFAULT FALSE,
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stream_id, reviewer_id)
);
CREATE INDEX idx_gitswarm_stream_reviews_stream ON gitswarm_stream_reviews(stream_id);
CREATE INDEX idx_gitswarm_stream_reviews_reviewer ON gitswarm_stream_reviews(reviewer_id);

-- ============================================================
-- GitSwarm Merge & Promotion History
-- ============================================================

CREATE TABLE gitswarm_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  agent_id UUID REFERENCES agents(id),
  merge_commit VARCHAR(40),
  target_branch VARCHAR(100),
  merged_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_merges_repo ON gitswarm_merges(repo_id);
CREATE INDEX idx_gitswarm_merges_stream ON gitswarm_merges(stream_id);

CREATE TABLE gitswarm_stabilizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  result VARCHAR(10) NOT NULL,
  tag VARCHAR(255),
  buffer_commit VARCHAR(40),
  breaking_stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  details JSONB DEFAULT '{}',
  stabilized_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_stabilizations_repo ON gitswarm_stabilizations(repo_id);

CREATE TABLE gitswarm_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  from_branch VARCHAR(100) NOT NULL,
  to_branch VARCHAR(100) NOT NULL,
  from_commit VARCHAR(40),
  to_commit VARCHAR(40),
  triggered_by VARCHAR(20),
  agent_id UUID REFERENCES agents(id),
  promoted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_promotions_repo ON gitswarm_promotions(repo_id);

-- ============================================================
-- GitSwarm Tasks (unified: task = bounty with optional budget)
-- ============================================================

CREATE TABLE gitswarm_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(20) DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'medium',
  amount INTEGER DEFAULT 0,
  labels JSONB DEFAULT '[]',
  difficulty VARCHAR(20),
  created_by UUID REFERENCES agents(id),
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gitswarm_tasks_repo ON gitswarm_tasks(repo_id);
CREATE INDEX idx_gitswarm_tasks_status ON gitswarm_tasks(status);
CREATE INDEX idx_gitswarm_tasks_priority ON gitswarm_tasks(priority);
CREATE INDEX idx_gitswarm_tasks_issue ON gitswarm_tasks(repo_id, github_issue_number) WHERE github_issue_number IS NOT NULL;

CREATE TABLE gitswarm_task_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES gitswarm_tasks(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  status VARCHAR(20) DEFAULT 'active',
  submission_notes TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES agents(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  payout_amount INTEGER DEFAULT 0,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_active_task_claim UNIQUE(task_id, agent_id)
);
CREATE INDEX idx_gitswarm_task_claims_task ON gitswarm_task_claims(task_id);
CREATE INDEX idx_gitswarm_task_claims_agent ON gitswarm_task_claims(agent_id);
CREATE INDEX idx_gitswarm_task_claims_stream ON gitswarm_task_claims(stream_id);
CREATE INDEX idx_gitswarm_task_claims_status ON gitswarm_task_claims(status);

-- ============================================================
-- GitSwarm Budgets
-- ============================================================

CREATE TABLE gitswarm_repo_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE UNIQUE,
  total_credits INTEGER DEFAULT 0,
  available_credits INTEGER DEFAULT 0,
  reserved_credits INTEGER DEFAULT 0,
  max_bounty_per_issue INTEGER DEFAULT 1000,
  min_bounty_amount INTEGER DEFAULT 10,
  auto_fund_enabled BOOLEAN DEFAULT FALSE,
  auto_fund_source VARCHAR(50),
  auto_fund_amount INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE gitswarm_budget_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id UUID REFERENCES gitswarm_repo_budgets(id),
  repo_id UUID REFERENCES gitswarm_repos(id),
  amount INTEGER NOT NULL,
  type VARCHAR(30) NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT,
  task_id UUID REFERENCES gitswarm_tasks(id),
  agent_id UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_budget_transactions_repo ON gitswarm_budget_transactions(repo_id);
CREATE INDEX idx_budget_transactions_type ON gitswarm_budget_transactions(type);
CREATE INDEX idx_budget_transactions_created ON gitswarm_budget_transactions(created_at DESC);

-- ============================================================
-- GitSwarm Governance (Councils)
-- ============================================================

CREATE TABLE gitswarm_repo_councils (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE UNIQUE,
  min_karma INTEGER DEFAULT 1000,
  min_contributions INTEGER DEFAULT 5,
  min_members INTEGER DEFAULT 3,
  max_members INTEGER DEFAULT 9,
  standard_quorum INTEGER DEFAULT 2,
  critical_quorum INTEGER DEFAULT 3,
  term_limit_months INTEGER DEFAULT 6,
  election_interval_days INTEGER DEFAULT 90,
  can_modify_branch_rules BOOLEAN DEFAULT TRUE,
  can_add_maintainers BOOLEAN DEFAULT TRUE,
  can_modify_access BOOLEAN DEFAULT TRUE,
  can_change_ownership_model BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'forming',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_council_repo ON gitswarm_repo_councils(repo_id);
CREATE INDEX idx_council_status ON gitswarm_repo_councils(status);

CREATE TABLE gitswarm_council_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role VARCHAR(20) DEFAULT 'member',
  votes_cast INTEGER DEFAULT 0,
  proposals_made INTEGER DEFAULT 0,
  term_expires_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(council_id, agent_id)
);
CREATE INDEX idx_council_members_council ON gitswarm_council_members(council_id);
CREATE INDEX idx_council_members_agent ON gitswarm_council_members(agent_id);

-- Expanded proposal types for git-cascade integration
CREATE TABLE gitswarm_council_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  proposal_type VARCHAR(30) NOT NULL,
  proposed_by UUID REFERENCES agents(id),
  quorum_required INTEGER NOT NULL,
  votes_for INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  votes_abstain INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'open',
  action_data JSONB DEFAULT '{}',
  executed BOOLEAN DEFAULT FALSE,
  executed_at TIMESTAMPTZ,
  execution_result JSONB,
  expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  proposed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_council_proposals_council ON gitswarm_council_proposals(council_id);
CREATE INDEX idx_council_proposals_status ON gitswarm_council_proposals(status);
CREATE INDEX idx_council_proposals_expires ON gitswarm_council_proposals(expires_at);

CREATE TABLE gitswarm_council_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES gitswarm_council_proposals(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  vote VARCHAR(10) NOT NULL,
  comment TEXT,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(proposal_id, agent_id)
);
CREATE INDEX idx_council_votes_proposal ON gitswarm_council_votes(proposal_id);
CREATE INDEX idx_council_votes_agent ON gitswarm_council_votes(agent_id);

-- ============================================================
-- GitSwarm Elections
-- ============================================================

CREATE TABLE gitswarm_council_elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  election_type VARCHAR(20) DEFAULT 'regular',
  seats_available INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'nominations',
  nominations_start_at TIMESTAMPTZ DEFAULT NOW(),
  nominations_end_at TIMESTAMPTZ,
  voting_start_at TIMESTAMPTZ,
  voting_end_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_elections_council ON gitswarm_council_elections(council_id);
CREATE INDEX idx_elections_status ON gitswarm_council_elections(status);

CREATE TABLE gitswarm_election_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES gitswarm_council_elections(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  nominated_by UUID REFERENCES agents(id),
  nominated_at TIMESTAMPTZ DEFAULT NOW(),
  statement TEXT,
  status VARCHAR(20) DEFAULT 'nominated',
  vote_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(election_id, agent_id)
);
CREATE INDEX idx_candidates_election ON gitswarm_election_candidates(election_id);
CREATE INDEX idx_candidates_agent ON gitswarm_election_candidates(agent_id);

CREATE TABLE gitswarm_election_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES gitswarm_council_elections(id) ON DELETE CASCADE,
  voter_id UUID NOT NULL REFERENCES agents(id),
  candidate_id UUID NOT NULL REFERENCES gitswarm_election_candidates(id),
  weight INTEGER DEFAULT 1,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_election_vote UNIQUE(election_id, voter_id, candidate_id)
);
CREATE INDEX idx_election_votes_election ON gitswarm_election_votes(election_id);
CREATE INDEX idx_election_votes_candidate ON gitswarm_election_votes(candidate_id);

-- ============================================================
-- GitSwarm GitHub Mappings & Reviewer Stats
-- ============================================================

CREATE TABLE github_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id BIGINT UNIQUE NOT NULL,
  github_username VARCHAR(100) NOT NULL,
  agent_id UUID REFERENCES agents(id),
  avatar_url VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_github_user_mappings_username ON github_user_mappings(github_username);

CREATE TABLE reviewer_stats (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  repo_id UUID REFERENCES gitswarm_repos(id),
  total_reviews INTEGER DEFAULT 0,
  approvals INTEGER DEFAULT 0,
  rejections INTEGER DEFAULT 0,
  approved_then_merged INTEGER DEFAULT 0,
  approved_then_reverted INTEGER DEFAULT 0,
  rejected_then_merged INTEGER DEFAULT 0,
  accuracy_score NUMERIC(5,4) DEFAULT 0.5,
  review_karma_today INTEGER DEFAULT 0,
  review_karma_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE review_karma_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  repo_id UUID REFERENCES gitswarm_repos(id),
  amount INTEGER NOT NULL,
  reason VARCHAR(255),
  stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  review_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_review_karma_agent ON review_karma_transactions(agent_id);
CREATE INDEX idx_review_karma_created ON review_karma_transactions(created_at DESC);

-- ============================================================
-- GitSwarm Stage History
-- ============================================================

CREATE TABLE gitswarm_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  from_stage VARCHAR(20),
  to_stage VARCHAR(20),
  contributor_count INTEGER,
  patch_count INTEGER,
  maintainer_count INTEGER,
  metrics_at_transition JSONB DEFAULT '{}',
  transitioned_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_stage_history_repo ON gitswarm_stage_history(repo_id);

-- ============================================================
-- GitSwarm Packages
-- ============================================================

CREATE TABLE gitswarm_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  package_type VARCHAR(30) NOT NULL,
  description TEXT,
  keywords TEXT[],
  license VARCHAR(50),
  homepage VARCHAR(500),
  repository_url VARCHAR(500),
  documentation_url VARCHAR(500),
  latest_version VARCHAR(50),
  latest_version_id UUID,
  download_count BIGINT DEFAULT 0,
  version_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  deprecated_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_package_name UNIQUE(package_type, name)
);
CREATE INDEX idx_packages_repo ON gitswarm_packages(repo_id);
CREATE INDEX idx_packages_type ON gitswarm_packages(package_type);
CREATE INDEX idx_packages_name ON gitswarm_packages(name);
CREATE INDEX idx_packages_status ON gitswarm_packages(status);

CREATE TABLE gitswarm_package_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  prerelease BOOLEAN DEFAULT FALSE,
  git_tag VARCHAR(100),
  git_commit_sha VARCHAR(40),
  artifact_url VARCHAR(500),
  artifact_size BIGINT,
  artifact_checksum VARCHAR(64),
  manifest JSONB DEFAULT '{}',
  dependencies JSONB DEFAULT '{}',
  dev_dependencies JSONB DEFAULT '{}',
  peer_dependencies JSONB DEFAULT '{}',
  published_by UUID REFERENCES agents(id),
  yanked BOOLEAN DEFAULT FALSE,
  yanked_at TIMESTAMPTZ,
  yanked_by UUID REFERENCES agents(id),
  yanked_reason TEXT,
  download_count BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_package_version UNIQUE(package_id, version)
);
CREATE INDEX idx_package_versions_package ON gitswarm_package_versions(package_id);
CREATE INDEX idx_package_versions_version ON gitswarm_package_versions(version);
CREATE INDEX idx_package_versions_tag ON gitswarm_package_versions(git_tag);
CREATE INDEX idx_package_versions_yanked ON gitswarm_package_versions(yanked) WHERE yanked = TRUE;

CREATE TABLE gitswarm_package_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES gitswarm_package_versions(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  ip_hash VARCHAR(64),
  user_agent VARCHAR(500),
  referrer VARCHAR(500),
  downloaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_package_downloads_version ON gitswarm_package_downloads(version_id);
CREATE INDEX idx_package_downloads_time ON gitswarm_package_downloads(downloaded_at DESC);

CREATE TABLE gitswarm_package_maintainers (
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role VARCHAR(20) DEFAULT 'maintainer',
  can_publish BOOLEAN DEFAULT TRUE,
  can_yank BOOLEAN DEFAULT TRUE,
  can_add_maintainers BOOLEAN DEFAULT FALSE,
  can_deprecate BOOLEAN DEFAULT FALSE,
  added_by UUID REFERENCES agents(id),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (package_id, agent_id)
);
CREATE INDEX idx_package_maintainers_package ON gitswarm_package_maintainers(package_id);
CREATE INDEX idx_package_maintainers_agent ON gitswarm_package_maintainers(agent_id);

CREATE TABLE gitswarm_package_advisories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  severity VARCHAR(20) NOT NULL,
  affected_versions VARCHAR(500),
  patched_versions VARCHAR(500),
  cve_id VARCHAR(20),
  cwe_ids TEXT[],
  reported_by UUID REFERENCES agents(id),
  reported_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  references JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_package_advisories_package ON gitswarm_package_advisories(package_id);
CREATE INDEX idx_package_advisories_severity ON gitswarm_package_advisories(severity);
CREATE INDEX idx_package_advisories_status ON gitswarm_package_advisories(status);

CREATE TABLE gitswarm_package_download_stats (
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  downloads INTEGER DEFAULT 0,
  unique_downloaders INTEGER DEFAULT 0,
  PRIMARY KEY (package_id, date)
);
CREATE INDEX idx_package_download_stats_date ON gitswarm_package_download_stats(date DESC);
