-- Migration: Plugin system gap remediation
--
-- Addresses gaps identified in the plugin system:
-- 1. workflow_file column for linking config plugins to their workflow files
-- 2. Execution token support for secure callback authentication
-- 3. Rate limit table cleanup index

-- Gap 1: Link config-sourced plugins to their corresponding workflow files
ALTER TABLE gitswarm_repo_plugins
  ADD COLUMN IF NOT EXISTS workflow_file VARCHAR(255);

-- Gap 8: Execution tokens for secure reporting from GitHub Actions
ALTER TABLE gitswarm_plugin_executions
  ADD COLUMN IF NOT EXISTS dispatch_token_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS dispatch_token_expires_at TIMESTAMPTZ;

-- Gap 14: Index for efficient rate limit cleanup
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON gitswarm_plugin_rate_limits (window_start);

-- Update execution_model comment to include 'workflow'
COMMENT ON COLUMN gitswarm_repo_plugins.execution_model IS
  'builtin | dispatch | workflow | webhook';

-- Update source comment to include 'workflow'
COMMENT ON COLUMN gitswarm_repo_plugins.source IS
  'config | api | workflow | catalog';
