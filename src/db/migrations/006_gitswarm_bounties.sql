-- GitSwarm Bounties and Budget Schema
-- Creates tables for issue bounties and resource budgets

-- ============================================================
-- Repository Budgets
-- ============================================================
CREATE TABLE gitswarm_repo_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Budget pool
  total_credits INTEGER DEFAULT 0,
  available_credits INTEGER DEFAULT 0,
  reserved_credits INTEGER DEFAULT 0, -- Claimed but not paid out

  -- Limits
  max_bounty_per_issue INTEGER DEFAULT 1000,
  min_bounty_amount INTEGER DEFAULT 10,

  -- Auto-fund settings
  auto_fund_enabled BOOLEAN DEFAULT FALSE,
  auto_fund_source VARCHAR(50), -- 'org_pool', 'sponsor', etc.
  auto_fund_amount INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT one_budget_per_repo UNIQUE (repo_id)
);

-- ============================================================
-- Issue Bounties
-- ============================================================
CREATE TABLE gitswarm_bounties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Issue reference
  github_issue_number INTEGER NOT NULL,
  github_issue_url VARCHAR(500),
  title VARCHAR(500),
  description TEXT,

  -- Bounty details
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) DEFAULT 'credits', -- 'credits', 'usd', etc.

  -- Status
  status VARCHAR(20) DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'in_progress', 'submitted', 'completed', 'cancelled', 'expired')),

  -- Deadline
  expires_at TIMESTAMPTZ,

  -- Labels/tags for categorization
  labels TEXT[],
  difficulty VARCHAR(20) CHECK (difficulty IN ('beginner', 'intermediate', 'advanced', 'expert')),

  -- Creator
  created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Funding source
  funded_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  funded_from VARCHAR(50) DEFAULT 'repo_budget', -- 'repo_budget', 'sponsor', 'personal'

  -- Completion
  completed_at TIMESTAMPTZ,

  CONSTRAINT unique_bounty_per_issue UNIQUE (repo_id, github_issue_number)
);

-- ============================================================
-- Bounty Claims
-- ============================================================
CREATE TABLE gitswarm_bounty_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES gitswarm_bounties(id) ON DELETE CASCADE,

  -- Claimer
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Status
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'submitted', 'approved', 'rejected', 'abandoned')),

  -- Work reference
  patch_id UUID REFERENCES patches(id) ON DELETE SET NULL,
  pr_url VARCHAR(500),

  -- Submission
  submitted_at TIMESTAMPTZ,
  submission_notes TEXT,

  -- Review
  reviewed_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,

  -- Payout
  payout_amount INTEGER,
  paid_at TIMESTAMPTZ,

  CONSTRAINT unique_active_claim UNIQUE (bounty_id, agent_id)
);

-- ============================================================
-- Budget Transactions
-- ============================================================
CREATE TABLE gitswarm_budget_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Transaction details
  amount INTEGER NOT NULL,
  type VARCHAR(30) NOT NULL
    CHECK (type IN (
      'deposit', 'withdrawal', 'bounty_created', 'bounty_claimed',
      'bounty_paid', 'bounty_cancelled', 'bounty_expired', 'transfer'
    )),

  -- Balance after transaction
  balance_after INTEGER NOT NULL,

  -- References
  bounty_id UUID REFERENCES gitswarm_bounties(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Notes
  description TEXT,

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_bounties_repo ON gitswarm_bounties(repo_id);
CREATE INDEX idx_bounties_status ON gitswarm_bounties(status);
CREATE INDEX idx_bounties_issue ON gitswarm_bounties(github_issue_number);
CREATE INDEX idx_bounties_expires ON gitswarm_bounties(expires_at);

CREATE INDEX idx_bounty_claims_bounty ON gitswarm_bounty_claims(bounty_id);
CREATE INDEX idx_bounty_claims_agent ON gitswarm_bounty_claims(agent_id);
CREATE INDEX idx_bounty_claims_status ON gitswarm_bounty_claims(status);

CREATE INDEX idx_budget_transactions_repo ON gitswarm_budget_transactions(repo_id);
CREATE INDEX idx_budget_transactions_type ON gitswarm_budget_transactions(type);
CREATE INDEX idx_budget_transactions_created ON gitswarm_budget_transactions(created_at);
