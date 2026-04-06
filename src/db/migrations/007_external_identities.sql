-- Migration 007: Cross-system agent identity
--
-- Links GitSwarm agents to their identities in external systems
-- (OpenHive, other GitSwarm instances, etc.).
-- Same pattern as gitswarm_agent_gitea_users but generalized.

CREATE TABLE IF NOT EXISTS gitswarm_agent_external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  system VARCHAR(50) NOT NULL,           -- 'openhive', 'gitswarm-remote', etc.
  external_id VARCHAR(255) NOT NULL,     -- ID in the external system
  external_name VARCHAR(255),            -- Display name in the external system
  metadata JSONB DEFAULT '{}',           -- System-specific data (capabilities, roles, etc.)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, system),
  UNIQUE(system, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_agent
  ON gitswarm_agent_external_identities(agent_id);

CREATE INDEX IF NOT EXISTS idx_external_identities_system_id
  ON gitswarm_agent_external_identities(system, external_id);
