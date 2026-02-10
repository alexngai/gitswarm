-- Migration 005: Cross-level integration fixes
--
-- Adds is_personal to gitswarm_orgs for CLI agent personal namespaces.
-- Adds unique constraints for sync deduplication.
-- Adds council_proposals/votes tables if they don't exist (referenced by batch sync).

-- ── gitswarm_orgs: is_personal flag for CLI agent namespaces ────
ALTER TABLE gitswarm_orgs ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT FALSE;

-- ── Unique constraints for idempotent sync ──────────────────────
-- Stabilizations: prevent duplicate entries from sync replays
CREATE UNIQUE INDEX IF NOT EXISTS idx_stabilizations_dedup
  ON gitswarm_stabilizations (repo_id, buffer_commit)
  WHERE buffer_commit IS NOT NULL;

-- Promotions: prevent duplicate entries from sync replays
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_dedup
  ON gitswarm_promotions (repo_id, from_commit, to_commit)
  WHERE from_commit IS NOT NULL AND to_commit IS NOT NULL;

-- ── Council tables (if not created by earlier migration) ────────
-- These are referenced by the batch sync processor and may not exist
-- if the repo-level council features weren't in the initial schema.
CREATE TABLE IF NOT EXISTS gitswarm_council_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  proposal_type VARCHAR(50) NOT NULL,
  proposed_by UUID NOT NULL REFERENCES agents(id),
  quorum_required INTEGER DEFAULT 2,
  votes_for INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  votes_abstain INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','passed','rejected','expired')),
  action_data JSONB DEFAULT '{}',
  executed BOOLEAN DEFAULT FALSE,
  executed_at TIMESTAMPTZ,
  execution_result TEXT,
  expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  proposed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gitswarm_council_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES gitswarm_council_proposals(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  vote VARCHAR(10) NOT NULL CHECK (vote IN ('for','against','abstain')),
  comment TEXT,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(proposal_id, agent_id)
);

-- ── Record migration ────────────────────────────────────────────
INSERT INTO migrations (name) VALUES ('005_cross_level_integration');
