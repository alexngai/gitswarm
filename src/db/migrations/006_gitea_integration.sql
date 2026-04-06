-- Migration 006: Gitea integration
--
-- Adds Gitea-specific columns alongside existing GitHub columns.
-- All changes are additive — existing GitHub-backed repos are unaffected.
-- The git_backend column (added in 002) already supports VARCHAR values;
-- this migration documents 'gitea' as a valid option.

-- ============================================================
-- Gitea columns on gitswarm_repos
-- ============================================================

ALTER TABLE gitswarm_repos
  ADD COLUMN IF NOT EXISTS gitea_repo_id BIGINT,
  ADD COLUMN IF NOT EXISTS gitea_owner VARCHAR(100),
  ADD COLUMN IF NOT EXISTS gitea_repo_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS gitea_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gitswarm_repos_gitea
  ON gitswarm_repos (gitea_repo_id)
  WHERE gitea_repo_id IS NOT NULL;

-- ============================================================
-- Gitea columns on gitswarm_orgs
-- ============================================================

ALTER TABLE gitswarm_orgs
  ADD COLUMN IF NOT EXISTS gitea_org_id BIGINT,
  ADD COLUMN IF NOT EXISTS gitea_org_name VARCHAR(100);

-- ============================================================
-- Per-repo auto-increment stream number (for GitHub API compat)
-- ============================================================

ALTER TABLE gitswarm_streams
  ADD COLUMN IF NOT EXISTS stream_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_pr_url TEXT;

-- Unique stream number per repo
CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_repo_stream_number
  ON gitswarm_streams (repo_id, stream_number)
  WHERE stream_number IS NOT NULL;

-- Function to auto-assign stream_number per repo
CREATE OR REPLACE FUNCTION assign_stream_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.stream_number IS NULL THEN
    SELECT COALESCE(MAX(stream_number), 0) + 1
    INTO NEW.stream_number
    FROM gitswarm_streams
    WHERE repo_id = NEW.repo_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trg_assign_stream_number ON gitswarm_streams;
CREATE TRIGGER trg_assign_stream_number
  BEFORE INSERT ON gitswarm_streams
  FOR EACH ROW
  EXECUTE FUNCTION assign_stream_number();

-- ============================================================
-- Per-repo auto-increment task number (for GitHub issues compat)
-- ============================================================

ALTER TABLE gitswarm_tasks
  ADD COLUMN IF NOT EXISTS task_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_issue_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_issue_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_repo_task_number
  ON gitswarm_tasks (repo_id, task_number)
  WHERE task_number IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_task_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.task_number IS NULL THEN
    SELECT COALESCE(MAX(task_number), 0) + 1
    INTO NEW.task_number
    FROM gitswarm_tasks
    WHERE repo_id = NEW.repo_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_task_number ON gitswarm_tasks;
CREATE TRIGGER trg_assign_task_number
  BEFORE INSERT ON gitswarm_tasks
  FOR EACH ROW
  EXECUTE FUNCTION assign_task_number();

-- ============================================================
-- Agent-to-Gitea-user mapping
-- ============================================================

CREATE TABLE IF NOT EXISTS gitswarm_agent_gitea_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  gitea_user_id BIGINT NOT NULL,
  gitea_username VARCHAR(100) NOT NULL,
  gitea_token_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id),
  UNIQUE(gitea_user_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_gitea_users_agent
  ON gitswarm_agent_gitea_users(agent_id);

-- ============================================================
-- Pending merge tracking (for pre-receive hook validation)
-- ============================================================

CREATE TABLE IF NOT EXISTS gitswarm_pending_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  expected_sha VARCHAR(40),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS idx_pending_merges_repo_sha
  ON gitswarm_pending_merges (repo_id, expected_sha)
  WHERE status = 'pending';

-- Cleanup job: expire old pending merges
-- (Application layer should call this periodically or on startup)
CREATE OR REPLACE FUNCTION cleanup_expired_pending_merges()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  UPDATE gitswarm_pending_merges
  SET status = 'expired'
  WHERE status = 'pending' AND expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
