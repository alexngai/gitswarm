-- Migration: Add git_backend column and stream dedup index
--
-- git_backend: selects the backend implementation for git operations
--   'github'  - GitHub REST API (default, backward-compatible)
--   'cascade' - Server-side git-cascade (Mode C)
--
-- Partial unique index on (repo_id, github_pr_number) prevents
-- duplicate stream records for the same GitHub PR.

ALTER TABLE gitswarm_repos
  ADD COLUMN IF NOT EXISTS git_backend VARCHAR(20) DEFAULT 'github';

-- Dedup: only one stream per repo+PR number
CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_repo_pr_dedup
  ON gitswarm_streams (repo_id, github_pr_number)
  WHERE github_pr_number IS NOT NULL;

-- Index for webhook lookups by repo+branch
CREATE INDEX IF NOT EXISTS idx_streams_repo_branch
  ON gitswarm_streams (repo_id, branch)
  WHERE status = 'active';
