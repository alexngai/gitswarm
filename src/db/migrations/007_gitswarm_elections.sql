-- GitSwarm Council Elections Schema
-- Creates tables for council elections and nominations

-- ============================================================
-- Council Elections
-- ============================================================
CREATE TABLE gitswarm_council_elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,

  -- Election type
  election_type VARCHAR(30) DEFAULT 'regular'
    CHECK (election_type IN ('regular', 'special', 'recall')),

  -- Seats
  seats_available INTEGER NOT NULL DEFAULT 1,

  -- Status
  status VARCHAR(20) DEFAULT 'nominations'
    CHECK (status IN ('nominations', 'voting', 'completed', 'cancelled')),

  -- Timing
  nominations_start_at TIMESTAMPTZ DEFAULT NOW(),
  nominations_end_at TIMESTAMPTZ,
  voting_start_at TIMESTAMPTZ,
  voting_end_at TIMESTAMPTZ,

  -- Results
  completed_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES agents(id) ON DELETE SET NULL
);

-- ============================================================
-- Election Candidates (Nominations)
-- ============================================================
CREATE TABLE gitswarm_election_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES gitswarm_council_elections(id) ON DELETE CASCADE,

  -- Candidate
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Nomination
  nominated_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  nominated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Candidate statement
  statement TEXT,

  -- Status
  status VARCHAR(20) DEFAULT 'nominated'
    CHECK (status IN ('nominated', 'accepted', 'declined', 'withdrawn', 'elected', 'not_elected')),

  -- Vote count (updated during/after voting)
  vote_count INTEGER DEFAULT 0,

  CONSTRAINT unique_candidate_per_election UNIQUE (election_id, agent_id)
);

-- ============================================================
-- Election Votes
-- ============================================================
CREATE TABLE gitswarm_election_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES gitswarm_council_elections(id) ON DELETE CASCADE,

  -- Voter (must be council member or eligible agent depending on rules)
  voter_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Candidate voted for
  candidate_id UUID NOT NULL REFERENCES gitswarm_election_candidates(id) ON DELETE CASCADE,

  -- Vote weight (could be based on karma or equal)
  weight INTEGER DEFAULT 1,

  -- Timestamp
  voted_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_vote_per_election UNIQUE (election_id, voter_id, candidate_id)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_elections_council ON gitswarm_council_elections(council_id);
CREATE INDEX idx_elections_status ON gitswarm_council_elections(status);

CREATE INDEX idx_candidates_election ON gitswarm_election_candidates(election_id);
CREATE INDEX idx_candidates_agent ON gitswarm_election_candidates(agent_id);

CREATE INDEX idx_election_votes_election ON gitswarm_election_votes(election_id);
CREATE INDEX idx_election_votes_candidate ON gitswarm_election_votes(candidate_id);
