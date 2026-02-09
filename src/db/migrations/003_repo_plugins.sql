-- ============================================================
-- Repo-Level Plugin Agent Federation
-- ============================================================
-- Extends GitSwarm with installable plugin agents that operate
-- at the repo level, reacting to GitSwarm events and performing
-- actions that bridge GitSwarm consensus with external systems.
--
-- Three layers:
--   1. Plugin Registry (what plugins exist)
--   2. Plugin Installations (which repos have which plugins)
--   3. Plugin Event Delivery (event dispatch + delivery log)

-- ============================================================
-- Plugin Registry
-- ============================================================
-- Global catalog of available plugin agents. Plugins are registered
-- by their author and can be installed on any repo.

CREATE TABLE gitswarm_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  author_id UUID REFERENCES agents(id),

  -- Plugin type determines execution model
  -- 'webhook': receives HTTP callbacks on events
  -- 'builtin': runs in-process (core gitswarm plugins)
  -- 'github_action': triggers GitHub Actions workflows
  plugin_type VARCHAR(20) NOT NULL DEFAULT 'webhook',

  -- Webhook endpoint for external plugins
  webhook_url TEXT,
  webhook_secret_hash VARCHAR(64),

  -- For github_action type: the workflow to trigger
  github_action_repo VARCHAR(255),
  github_action_workflow VARCHAR(255),

  -- Capabilities this plugin requests (checked at install time)
  -- e.g. ["read:streams", "write:reviews", "read:issues", "action:merge", "action:label"]
  capabilities JSONB DEFAULT '[]',

  -- Events this plugin subscribes to
  -- e.g. ["stream_created", "consensus_reached", "issue_opened", "stabilization"]
  subscribed_events JSONB DEFAULT '[]',

  -- Configuration schema (JSON Schema format)
  -- Defines what settings repo owners can configure when installing
  config_schema JSONB DEFAULT '{}',

  -- Default configuration values
  default_config JSONB DEFAULT '{}',

  -- Plugin metadata
  version VARCHAR(20) DEFAULT '0.1.0',
  homepage_url TEXT,
  documentation_url TEXT,
  icon_url TEXT,
  is_official BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMPTZ,

  -- Lifecycle
  status VARCHAR(20) DEFAULT 'active',  -- active, deprecated, suspended, deleted
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugins_slug ON gitswarm_plugins(slug);
CREATE INDEX idx_plugins_author ON gitswarm_plugins(author_id);
CREATE INDEX idx_plugins_type ON gitswarm_plugins(plugin_type);
CREATE INDEX idx_plugins_status ON gitswarm_plugins(status);

-- ============================================================
-- Plugin Installations
-- ============================================================
-- Per-repo plugin installations. Each installation has its own
-- configuration and granted capabilities.

CREATE TABLE gitswarm_plugin_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  plugin_id UUID NOT NULL REFERENCES gitswarm_plugins(id) ON DELETE CASCADE,
  installed_by UUID REFERENCES agents(id),

  -- Capabilities actually granted (subset of plugin's requested capabilities)
  -- Repo owner can grant fewer capabilities than the plugin requests
  granted_capabilities JSONB DEFAULT '[]',

  -- Repo-specific configuration (merged with plugin defaults)
  config JSONB DEFAULT '{}',

  -- Event subscriptions (can be narrowed from plugin defaults)
  -- null = use plugin's default subscribed_events
  subscribed_events JSONB,

  -- Execution constraints
  enabled BOOLEAN DEFAULT TRUE,
  priority INTEGER DEFAULT 100,          -- lower = runs first
  rate_limit_per_hour INTEGER DEFAULT 60,
  max_retries INTEGER DEFAULT 3,

  -- Stats
  events_received INTEGER DEFAULT 0,
  events_succeeded INTEGER DEFAULT 0,
  events_failed INTEGER DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,

  -- Lifecycle
  status VARCHAR(20) DEFAULT 'active',   -- active, paused, error, uninstalled
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_repo_plugin UNIQUE(repo_id, plugin_id)
);

CREATE INDEX idx_plugin_installations_repo ON gitswarm_plugin_installations(repo_id);
CREATE INDEX idx_plugin_installations_plugin ON gitswarm_plugin_installations(plugin_id);
CREATE INDEX idx_plugin_installations_status ON gitswarm_plugin_installations(status);

-- ============================================================
-- Plugin Event Delivery Log
-- ============================================================
-- Every event dispatched to a plugin is logged for auditability,
-- debugging, and retry management.

CREATE TABLE gitswarm_plugin_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES gitswarm_plugin_installations(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  plugin_id UUID NOT NULL REFERENCES gitswarm_plugins(id),

  -- Event details
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',

  -- Delivery tracking
  status VARCHAR(20) DEFAULT 'pending',  -- pending, delivered, failed, skipped
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_retry_at TIMESTAMPTZ,

  -- Response from plugin
  response_status INTEGER,
  response_body JSONB,

  -- Plugin actions taken (what the plugin did in response)
  -- e.g. [{"action": "add_label", "target": "issue:42", "label": "triaged"}]
  actions_taken JSONB DEFAULT '[]',

  -- Timing
  delivered_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_events_installation ON gitswarm_plugin_events(installation_id);
CREATE INDEX idx_plugin_events_repo ON gitswarm_plugin_events(repo_id);
CREATE INDEX idx_plugin_events_status ON gitswarm_plugin_events(status);
CREATE INDEX idx_plugin_events_retry ON gitswarm_plugin_events(next_retry_at)
  WHERE status = 'pending' AND next_retry_at IS NOT NULL;
CREATE INDEX idx_plugin_events_created ON gitswarm_plugin_events(created_at DESC);

-- ============================================================
-- Plugin Actions (what plugins are allowed to do)
-- ============================================================
-- When a plugin responds to an event, it can request actions.
-- These actions are validated against granted_capabilities
-- before execution.

CREATE TABLE gitswarm_plugin_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES gitswarm_plugin_events(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES gitswarm_plugin_installations(id),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id),

  -- Action details
  action_type VARCHAR(50) NOT NULL,
  -- e.g. 'approve_merge', 'add_review', 'create_task', 'add_label',
  --      'post_comment', 'trigger_stabilization', 'update_config'
  target_type VARCHAR(30),               -- 'stream', 'issue', 'task', 'repo'
  target_id VARCHAR(255),
  action_data JSONB DEFAULT '{}',

  -- Capability required (checked against installation's granted_capabilities)
  required_capability VARCHAR(50) NOT NULL,

  -- Execution
  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, executed, rejected, failed
  executed_at TIMESTAMPTZ,
  execution_result JSONB,
  rejection_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_actions_event ON gitswarm_plugin_actions(event_id);
CREATE INDEX idx_plugin_actions_installation ON gitswarm_plugin_actions(installation_id);
CREATE INDEX idx_plugin_actions_status ON gitswarm_plugin_actions(status);
CREATE INDEX idx_plugin_actions_type ON gitswarm_plugin_actions(action_type);

-- ============================================================
-- Plugin Capability Definitions
-- ============================================================
-- Reference table of all available capabilities and what they allow.

CREATE TABLE gitswarm_plugin_capabilities (
  id VARCHAR(50) PRIMARY KEY,            -- e.g. 'read:streams', 'action:merge'
  category VARCHAR(20) NOT NULL,         -- 'read', 'write', 'action'
  description TEXT NOT NULL,
  risk_level VARCHAR(10) DEFAULT 'low',  -- low, medium, high, critical
  requires_maintainer BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed capability definitions
INSERT INTO gitswarm_plugin_capabilities (id, category, description, risk_level, requires_maintainer) VALUES
  -- Read capabilities
  ('read:streams',     'read',   'Read stream metadata, status, and diffs', 'low', false),
  ('read:reviews',     'read',   'Read review verdicts and feedback', 'low', false),
  ('read:issues',      'read',   'Read issue details and comments', 'low', false),
  ('read:tasks',       'read',   'Read task and bounty information', 'low', false),
  ('read:config',      'read',   'Read repository configuration', 'low', false),
  ('read:agents',      'read',   'Read agent profiles and karma', 'low', false),
  ('read:consensus',   'read',   'Read consensus state for streams', 'low', false),

  -- Write capabilities
  ('write:reviews',    'write',  'Submit reviews on streams (as plugin identity)', 'medium', false),
  ('write:comments',   'write',  'Post comments on issues and streams', 'medium', false),
  ('write:labels',     'write',  'Add or remove labels on issues', 'medium', false),
  ('write:tasks',      'write',  'Create and update tasks/bounties', 'medium', false),
  ('write:metadata',   'write',  'Update stream or issue metadata', 'medium', false),

  -- Action capabilities (high-impact)
  ('action:merge',     'action', 'Approve or trigger merge operations', 'critical', true),
  ('action:promote',   'action', 'Trigger buffer-to-main promotion', 'critical', true),
  ('action:stabilize', 'action', 'Trigger stabilization runs', 'high', true),
  ('action:assign',    'action', 'Assign agents to tasks', 'medium', false),
  ('action:close',     'action', 'Close issues or abandon streams', 'high', true),
  ('action:revert',    'action', 'Revert merged streams', 'critical', true),
  ('action:github_pr', 'action', 'Create or update GitHub pull requests', 'high', true),
  ('action:approve_pr','action', 'Submit GitHub PR approvals via the GitHub App', 'critical', true);
