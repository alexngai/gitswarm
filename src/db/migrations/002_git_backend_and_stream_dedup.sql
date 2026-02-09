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

-- Fix legacy patch_reviews schema: webhook code uses 'feedback' (TEXT)
-- but original schema had 'comments' (JSONB). Also add github_review_id.
ALTER TABLE patch_reviews
  ADD COLUMN IF NOT EXISTS feedback TEXT;

ALTER TABLE patch_reviews
  ADD COLUMN IF NOT EXISTS github_review_id BIGINT;

-- Backfill: copy comments JSONB into feedback TEXT for existing rows
UPDATE patch_reviews SET feedback = comments::TEXT
  WHERE feedback IS NULL AND comments IS NOT NULL AND comments != '{}';

-- Add reviewed_at if missing (original schema only had created_at)
ALTER TABLE patch_reviews
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ DEFAULT NOW();
