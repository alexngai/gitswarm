-- GitSwarm Package Registry Schema
-- Creates tables for package publishing and distribution

-- ============================================================
-- Packages
-- ============================================================
CREATE TABLE gitswarm_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,

  -- Package identity
  name VARCHAR(200) NOT NULL,
  package_type VARCHAR(30) NOT NULL
    CHECK (package_type IN ('npm', 'pypi', 'cargo', 'go', 'maven', 'generic')),

  -- Package info
  description TEXT,
  keywords TEXT[],
  license VARCHAR(50),
  homepage VARCHAR(500),
  repository_url VARCHAR(500),
  documentation_url VARCHAR(500),

  -- Latest version (denormalized for quick access)
  latest_version VARCHAR(50),
  latest_version_id UUID,

  -- Stats
  download_count BIGINT DEFAULT 0,
  version_count INTEGER DEFAULT 0,

  -- Status
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'deprecated', 'removed')),
  deprecated_message TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT unique_package_name UNIQUE (package_type, name)
);

-- ============================================================
-- Package Versions
-- ============================================================
CREATE TABLE gitswarm_package_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,

  -- Version info
  version VARCHAR(50) NOT NULL,
  prerelease BOOLEAN DEFAULT FALSE,

  -- Git info
  git_tag VARCHAR(100),
  git_commit_sha VARCHAR(40),

  -- Artifact info
  artifact_url VARCHAR(500) NOT NULL,
  artifact_size BIGINT,
  artifact_checksum VARCHAR(64), -- SHA256

  -- Package manifest (package.json, Cargo.toml, etc.)
  manifest JSONB DEFAULT '{}',

  -- Dependencies (parsed from manifest)
  dependencies JSONB DEFAULT '{}',
  dev_dependencies JSONB DEFAULT '{}',
  peer_dependencies JSONB DEFAULT '{}',

  -- Publisher
  published_by UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Yank support (soft delete for security issues)
  yanked BOOLEAN DEFAULT FALSE,
  yanked_at TIMESTAMPTZ,
  yanked_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  yanked_reason TEXT,

  -- Stats
  download_count BIGINT DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT unique_package_version UNIQUE (package_id, version)
);

-- ============================================================
-- Package Downloads (for tracking)
-- ============================================================
CREATE TABLE gitswarm_package_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES gitswarm_package_versions(id) ON DELETE CASCADE,

  -- Downloader (optional - may be anonymous)
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Context
  ip_hash VARCHAR(64), -- Hashed IP for rate limiting
  user_agent VARCHAR(500),
  referrer VARCHAR(500),

  -- Timestamp
  downloaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Package Maintainers
-- ============================================================
-- Separate from repo maintainers - package-specific permissions
CREATE TABLE gitswarm_package_maintainers (
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Role
  role VARCHAR(20) DEFAULT 'maintainer'
    CHECK (role IN ('owner', 'maintainer', 'publisher')),

  -- Permissions
  can_publish BOOLEAN DEFAULT TRUE,
  can_yank BOOLEAN DEFAULT TRUE,
  can_add_maintainers BOOLEAN DEFAULT FALSE,
  can_deprecate BOOLEAN DEFAULT FALSE,

  -- Tracking
  added_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (package_id, agent_id)
);

-- ============================================================
-- Package Security Advisories
-- ============================================================
CREATE TABLE gitswarm_package_advisories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,

  -- Advisory info
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL
    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),

  -- Affected versions (semver range)
  affected_versions VARCHAR(500) NOT NULL,
  patched_versions VARCHAR(500),

  -- CVE/CWE tracking
  cve_id VARCHAR(20),
  cwe_ids TEXT[],

  -- Reporter
  reported_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  reported_at TIMESTAMPTZ DEFAULT NOW(),

  -- Status
  status VARCHAR(20) DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'fixed', 'disputed', 'withdrawn')),
  resolved_at TIMESTAMPTZ,

  -- References
  references JSONB DEFAULT '[]'
);

-- ============================================================
-- Download Stats (aggregated)
-- ============================================================
CREATE TABLE gitswarm_package_download_stats (
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  date DATE NOT NULL,

  -- Counts
  downloads INTEGER DEFAULT 0,
  unique_downloaders INTEGER DEFAULT 0,

  PRIMARY KEY (package_id, date)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_packages_repo ON gitswarm_packages(repo_id);
CREATE INDEX idx_packages_type ON gitswarm_packages(package_type);
CREATE INDEX idx_packages_name ON gitswarm_packages(name);
CREATE INDEX idx_packages_status ON gitswarm_packages(status);

CREATE INDEX idx_package_versions_package ON gitswarm_package_versions(package_id);
CREATE INDEX idx_package_versions_version ON gitswarm_package_versions(version);
CREATE INDEX idx_package_versions_tag ON gitswarm_package_versions(git_tag);
CREATE INDEX idx_package_versions_yanked ON gitswarm_package_versions(yanked);

CREATE INDEX idx_package_downloads_version ON gitswarm_package_downloads(version_id);
CREATE INDEX idx_package_downloads_time ON gitswarm_package_downloads(downloaded_at);

CREATE INDEX idx_package_maintainers_package ON gitswarm_package_maintainers(package_id);
CREATE INDEX idx_package_maintainers_agent ON gitswarm_package_maintainers(agent_id);

CREATE INDEX idx_package_advisories_package ON gitswarm_package_advisories(package_id);
CREATE INDEX idx_package_advisories_severity ON gitswarm_package_advisories(severity);
CREATE INDEX idx_package_advisories_status ON gitswarm_package_advisories(status);

CREATE INDEX idx_package_download_stats_date ON gitswarm_package_download_stats(date);
