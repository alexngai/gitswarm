-- Migration: Repo-level plugin system
--
-- Enables repos to define automated behaviors via plugins that are
-- triggered by gitswarm/GitHub events. Plugins dispatch work to
-- GitHub Actions (where installed AI agents like Claude/Codex/Copilot
-- do the actual compute) or execute lightweight built-in actions.

-- Plugin installations per repo (source of truth from .gitswarm/plugins.yml)
CREATE TABLE IF NOT EXISTS gitswarm_repo_plugins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,           -- e.g. 'issue-triage', 'auto-promote'
  enabled         BOOLEAN DEFAULT true,
  tier            VARCHAR(20) NOT NULL DEFAULT 'automation',  -- 'automation' | 'ai' | 'governance'
  trigger_event   VARCHAR(100) NOT NULL,           -- e.g. 'issues.opened', 'gitswarm.consensus_reached'
  conditions      JSONB DEFAULT '{}',              -- conditions that must be met to fire
  actions         JSONB DEFAULT '[]',              -- ordered list of actions to execute
  safe_outputs    JSONB DEFAULT '{}',              -- mutation budget limits
  config          JSONB DEFAULT '{}',              -- plugin-specific configuration
  execution_model VARCHAR(20) DEFAULT 'dispatch',  -- 'builtin' | 'dispatch' | 'webhook'
  dispatch_target VARCHAR(255),                    -- GitHub Actions event_type or webhook URL
  priority        INTEGER DEFAULT 0,               -- execution order (higher = first)
  source          VARCHAR(20) DEFAULT 'config',    -- 'config' (from .gitswarm/) | 'api' | 'catalog'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_id, name)
);

-- Plugin execution log (audit trail)
CREATE TABLE IF NOT EXISTS gitswarm_plugin_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  plugin_id       UUID NOT NULL REFERENCES gitswarm_repo_plugins(id) ON DELETE CASCADE,
  trigger_event   VARCHAR(100) NOT NULL,
  trigger_payload JSONB DEFAULT '{}',              -- the event that triggered this execution
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked'
  actions_taken   JSONB DEFAULT '[]',              -- what the plugin actually did
  safe_output_usage JSONB DEFAULT '{}',            -- how much of the budget was consumed
  error_message   TEXT,
  dispatch_id     VARCHAR(255),                    -- GitHub Actions run ID or webhook delivery ID
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Repo-level config sync tracking
CREATE TABLE IF NOT EXISTS gitswarm_repo_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE UNIQUE,
  config_sha      VARCHAR(40),                     -- git SHA of .gitswarm/config.yml
  plugins_sha     VARCHAR(40),                     -- git SHA of .gitswarm/plugins.yml
  config_data     JSONB DEFAULT '{}',              -- parsed config.yml contents
  plugins_data    JSONB DEFAULT '{}',              -- parsed plugins.yml contents
  plugins_enabled BOOLEAN DEFAULT true,            -- global kill switch
  last_synced_at  TIMESTAMPTZ,
  sync_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Rate limiting for plugin executions
CREATE TABLE IF NOT EXISTS gitswarm_plugin_rate_limits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id       UUID NOT NULL REFERENCES gitswarm_repo_plugins(id) ON DELETE CASCADE,
  window_start    TIMESTAMPTZ NOT NULL,
  window_type     VARCHAR(20) NOT NULL,            -- 'hour' | 'day'
  execution_count INTEGER DEFAULT 0,
  UNIQUE(plugin_id, window_start, window_type)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_repo_plugins_repo_event
  ON gitswarm_repo_plugins (repo_id, trigger_event)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_plugin_executions_repo
  ON gitswarm_plugin_executions (repo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_executions_plugin
  ON gitswarm_plugin_executions (plugin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_executions_status
  ON gitswarm_plugin_executions (status)
  WHERE status IN ('pending', 'dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_repo_config_repo
  ON gitswarm_repo_config (repo_id);

-- Add plugins_enabled flag to repos table for quick checks
ALTER TABLE gitswarm_repos
  ADD COLUMN IF NOT EXISTS plugins_enabled BOOLEAN DEFAULT false;
