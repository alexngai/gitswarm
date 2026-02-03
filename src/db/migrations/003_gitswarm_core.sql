-- GitSwarm Core Schema
-- Creates tables for the agent development ecosystem

-- ============================================================
-- GitSwarm Organizations
-- ============================================================
-- Organizations that have installed the BotHub GitHub App
CREATE TABLE gitswarm_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- GitHub identity
  github_org_name VARCHAR(100) NOT NULL,
  github_org_id BIGINT NOT NULL,
  github_installation_id BIGINT NOT NULL,

  -- Access control defaults
  default_agent_access VARCHAR(20) DEFAULT 'none'
    CHECK (default_agent_access IN ('none', 'public', 'karma_threshold', 'allowlist')),
  default_min_karma INTEGER DEFAULT 0,

  -- Platform org flag (gitswarm-public)
  is_platform_org BOOLEAN DEFAULT FALSE,

  -- Ownership (human or agent who installed/manages)
  owner_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  owner_type VARCHAR(20) DEFAULT 'human'
    CHECK (owner_type IN ('human', 'agent')),

  -- Status
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'uninstalled')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Metadata (avatar URL, description, etc.)
  metadata JSONB DEFAULT '{}',

  -- Constraints
  CONSTRAINT unique_github_org UNIQUE (github_org_name),
  CONSTRAINT unique_installation UNIQUE (github_installation_id)
);

-- ============================================================
-- GitSwarm Repositories
-- ============================================================
CREATE TABLE gitswarm_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES gitswarm_orgs(id) ON DELETE CASCADE,

  -- GitHub identity
  github_repo_name VARCHAR(100) NOT NULL,
  github_repo_id BIGINT NOT NULL,
  github_full_name VARCHAR(200) NOT NULL, -- "org/repo"

  -- Visibility
  is_private BOOLEAN DEFAULT FALSE,

  -- Governance model
  ownership_model VARCHAR(20) DEFAULT 'open'
    CHECK (ownership_model IN ('solo', 'guild', 'open')),
  consensus_threshold DECIMAL(3,2) DEFAULT 0.66
    CHECK (consensus_threshold >= 0 AND consensus_threshold <= 1),
  min_reviews INTEGER DEFAULT 1,

  -- Access control (NULL = inherit from org)
  agent_access VARCHAR(20)
    CHECK (agent_access IS NULL OR agent_access IN ('none', 'public', 'karma_threshold', 'allowlist')),
  min_karma INTEGER,

  -- Repository info
  description TEXT,
  default_branch VARCHAR(100) DEFAULT 'main',
  primary_language VARCHAR(50),

  -- Status
  is_archived BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'removed')),

  -- Project stage
  stage VARCHAR(20) DEFAULT 'early'
    CHECK (stage IN ('early', 'growing', 'established', 'mature')),
  contributor_count INTEGER DEFAULT 0,
  patch_count INTEGER DEFAULT 0,

  -- Human-agent collaboration settings
  human_review_weight DECIMAL(3,2) DEFAULT 1.5,
  require_human_approval BOOLEAN DEFAULT FALSE,
  human_can_force_merge BOOLEAN DEFAULT TRUE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Constraints
  CONSTRAINT unique_repo_in_org UNIQUE (org_id, github_repo_name),
  CONSTRAINT unique_github_repo UNIQUE (github_repo_id)
);

-- ============================================================
-- Agent Access to Repositories
-- ============================================================
CREATE TABLE gitswarm_repo_access (
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Permission level
  access_level VARCHAR(20) DEFAULT 'read'
    CHECK (access_level IN ('none', 'read', 'write', 'maintain', 'admin')),

  -- Grant tracking
  granted_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- NULL = no expiry

  -- Notes
  reason TEXT,

  PRIMARY KEY (repo_id, agent_id)
);

-- ============================================================
-- Repository Maintainers
-- ============================================================
CREATE TABLE gitswarm_maintainers (
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Role
  role VARCHAR(20) DEFAULT 'maintainer'
    CHECK (role IN ('owner', 'maintainer')),

  -- Tracking
  added_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (repo_id, agent_id)
);

-- ============================================================
-- GitSwarm Patches (links patches to gitswarm repos)
-- ============================================================
CREATE TABLE gitswarm_patches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patch_id UUID NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- GitHub PR info
  github_pr_number INTEGER,
  github_pr_url VARCHAR(500),
  github_branch VARCHAR(255),

  -- Target branch
  base_branch VARCHAR(100) DEFAULT 'main',

  -- Status sync
  github_pr_state VARCHAR(20),
  last_synced_at TIMESTAMPTZ,

  CONSTRAINT unique_patch_gitswarm UNIQUE (patch_id)
);

-- ============================================================
-- Branch Protection Rules
-- ============================================================
CREATE TABLE gitswarm_branch_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Pattern (supports wildcards: main, release/*, feature/*)
  branch_pattern VARCHAR(255) NOT NULL,

  -- Push restrictions
  direct_push VARCHAR(20) DEFAULT 'none'
    CHECK (direct_push IN ('none', 'maintainers', 'all')),

  -- PR requirements
  required_approvals INTEGER DEFAULT 1,
  require_tests_pass BOOLEAN DEFAULT TRUE,
  require_up_to_date BOOLEAN DEFAULT FALSE,

  -- Override consensus threshold for this branch
  consensus_threshold DECIMAL(3,2)
    CHECK (consensus_threshold IS NULL OR (consensus_threshold >= 0 AND consensus_threshold <= 1)),

  -- Restrict who can merge
  merge_restriction VARCHAR(20) DEFAULT 'consensus'
    CHECK (merge_restriction IN ('none', 'maintainers', 'consensus')),

  -- Priority (higher = more specific)
  priority INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_branch_rule UNIQUE (repo_id, branch_pattern)
);

-- ============================================================
-- GitHub User Mappings (for human-agent collaboration)
-- ============================================================
CREATE TABLE github_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id BIGINT NOT NULL UNIQUE,
  github_username VARCHAR(100) NOT NULL,

  -- Optional link to BotHub agent (if user has one)
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Cached info
  avatar_url VARCHAR(500),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Reviewer Stats (for tracking review accuracy)
-- ============================================================
CREATE TABLE reviewer_stats (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,

  -- Review counts
  total_reviews INTEGER DEFAULT 0,
  approvals INTEGER DEFAULT 0,
  rejections INTEGER DEFAULT 0,

  -- Outcome tracking
  approved_then_merged INTEGER DEFAULT 0,
  approved_then_reverted INTEGER DEFAULT 0,
  rejected_then_merged INTEGER DEFAULT 0,

  -- Calculated accuracy (updated periodically)
  accuracy_score DECIMAL(3,2) DEFAULT 1.0,

  -- Daily karma tracking
  review_karma_today INTEGER DEFAULT 0,
  review_karma_date DATE DEFAULT CURRENT_DATE,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_gitswarm_orgs_github_name ON gitswarm_orgs(github_org_name);
CREATE INDEX idx_gitswarm_orgs_installation ON gitswarm_orgs(github_installation_id);
CREATE INDEX idx_gitswarm_orgs_status ON gitswarm_orgs(status);

CREATE INDEX idx_gitswarm_repos_org ON gitswarm_repos(org_id);
CREATE INDEX idx_gitswarm_repos_github_id ON gitswarm_repos(github_repo_id);
CREATE INDEX idx_gitswarm_repos_full_name ON gitswarm_repos(github_full_name);
CREATE INDEX idx_gitswarm_repos_status ON gitswarm_repos(status);
CREATE INDEX idx_gitswarm_repos_stage ON gitswarm_repos(stage);

CREATE INDEX idx_gitswarm_repo_access_agent ON gitswarm_repo_access(agent_id);
CREATE INDEX idx_gitswarm_repo_access_repo ON gitswarm_repo_access(repo_id);

CREATE INDEX idx_gitswarm_maintainers_agent ON gitswarm_maintainers(agent_id);
CREATE INDEX idx_gitswarm_maintainers_repo ON gitswarm_maintainers(repo_id);

CREATE INDEX idx_gitswarm_patches_patch ON gitswarm_patches(patch_id);
CREATE INDEX idx_gitswarm_patches_repo ON gitswarm_patches(repo_id);
CREATE INDEX idx_gitswarm_patches_pr ON gitswarm_patches(github_pr_number);

CREATE INDEX idx_gitswarm_branch_rules_repo ON gitswarm_branch_rules(repo_id);

CREATE INDEX idx_github_user_mappings_username ON github_user_mappings(github_username);
