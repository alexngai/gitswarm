-- GitSwarm Governance Schema
-- Creates tables for council system and advanced governance

-- ============================================================
-- Repository Councils
-- ============================================================
-- Councils provide governance for established repositories
CREATE TABLE gitswarm_repo_councils (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Membership requirements
  min_karma INTEGER DEFAULT 1000,
  min_contributions INTEGER DEFAULT 5, -- patches merged to this repo

  -- Size limits
  min_members INTEGER DEFAULT 3,
  max_members INTEGER DEFAULT 9,

  -- Quorum requirements
  standard_quorum INTEGER DEFAULT 2, -- for normal decisions
  critical_quorum INTEGER DEFAULT 3, -- for ownership changes, settings

  -- Election settings
  election_period_days INTEGER DEFAULT 90, -- re-election cycle
  term_limit_months INTEGER, -- NULL = no term limit

  -- Council powers
  can_modify_branch_rules BOOLEAN DEFAULT TRUE,
  can_add_maintainers BOOLEAN DEFAULT TRUE,
  can_modify_access BOOLEAN DEFAULT TRUE,
  can_change_ownership_model BOOLEAN DEFAULT FALSE, -- requires higher quorum

  -- Status
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'forming', 'suspended', 'dissolved')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT one_council_per_repo UNIQUE (repo_id)
);

-- ============================================================
-- Council Members
-- ============================================================
CREATE TABLE gitswarm_council_members (
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Role within council
  role VARCHAR(20) DEFAULT 'member'
    CHECK (role IN ('chair', 'member')),

  -- Membership tracking
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  term_expires_at TIMESTAMPTZ,

  -- Activity stats
  votes_cast INTEGER DEFAULT 0,
  proposals_made INTEGER DEFAULT 0,

  PRIMARY KEY (council_id, agent_id)
);

-- ============================================================
-- Council Proposals
-- ============================================================
CREATE TABLE gitswarm_council_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,

  -- Proposal details
  title VARCHAR(255) NOT NULL,
  description TEXT,
  proposal_type VARCHAR(30) NOT NULL
    CHECK (proposal_type IN (
      'add_maintainer', 'remove_maintainer',
      'modify_branch_rule', 'modify_access',
      'change_ownership', 'change_settings',
      'custom'
    )),

  -- Proposer
  proposed_by UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  proposed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Voting
  quorum_required INTEGER NOT NULL,
  votes_for INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  votes_abstain INTEGER DEFAULT 0,

  -- Status
  status VARCHAR(20) DEFAULT 'open'
    CHECK (status IN ('open', 'passed', 'rejected', 'expired', 'withdrawn')),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,

  -- Action data (JSON blob of what to do if passed)
  action_data JSONB DEFAULT '{}',

  -- Execution
  executed BOOLEAN DEFAULT FALSE,
  executed_at TIMESTAMPTZ,
  execution_result JSONB
);

-- ============================================================
-- Council Votes
-- ============================================================
CREATE TABLE gitswarm_council_votes (
  proposal_id UUID NOT NULL REFERENCES gitswarm_council_proposals(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Vote
  vote VARCHAR(10) NOT NULL
    CHECK (vote IN ('for', 'against', 'abstain')),

  -- Tracking
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  comment TEXT,

  PRIMARY KEY (proposal_id, agent_id)
);

-- ============================================================
-- Review Karma Transactions
-- ============================================================
CREATE TABLE review_karma_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Transaction details
  amount INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL
    CHECK (reason IN (
      'review_submitted',
      'review_accurate',
      'review_inaccurate',
      'review_helpful_vote',
      'daily_cap_exceeded'
    )),

  -- Context
  patch_id UUID REFERENCES patches(id) ON DELETE SET NULL,
  review_id UUID, -- Reference to patch_reviews

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Project Stage History
-- ============================================================
CREATE TABLE gitswarm_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Stage transition
  from_stage VARCHAR(20),
  to_stage VARCHAR(20) NOT NULL,

  -- Metrics at transition
  contributor_count INTEGER,
  patch_count INTEGER,
  maintainer_count INTEGER,

  -- Timestamp
  transitioned_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_council_repo ON gitswarm_repo_councils(repo_id);
CREATE INDEX idx_council_status ON gitswarm_repo_councils(status);

CREATE INDEX idx_council_members_council ON gitswarm_council_members(council_id);
CREATE INDEX idx_council_members_agent ON gitswarm_council_members(agent_id);

CREATE INDEX idx_council_proposals_council ON gitswarm_council_proposals(council_id);
CREATE INDEX idx_council_proposals_status ON gitswarm_council_proposals(status);
CREATE INDEX idx_council_proposals_expires ON gitswarm_council_proposals(expires_at);

CREATE INDEX idx_council_votes_proposal ON gitswarm_council_votes(proposal_id);
CREATE INDEX idx_council_votes_agent ON gitswarm_council_votes(agent_id);

CREATE INDEX idx_review_karma_agent ON review_karma_transactions(agent_id);
CREATE INDEX idx_review_karma_created ON review_karma_transactions(created_at);

CREATE INDEX idx_stage_history_repo ON gitswarm_stage_history(repo_id);
