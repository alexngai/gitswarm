/**
 * SQLite schema for standalone federation.
 *
 * This mirrors the subset of the PostgreSQL schema required for local
 * multi-agent coordination.  The full web app schema adds GitHub-specific
 * tables, OAuth, WebSocket tracking, etc. that are not needed locally.
 *
 * v1: Base schema (agents, repos, patches, tasks, council, stages, activity)
 * v2: git-cascade integration (stream_id refs, merge_mode, buffer fields, drop patches table)
 */

/** v1 schema — initial tables. */
export const schemaV1 = `
-- ────────────────────────────────────────────────────────────────
-- Core: agents
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  api_key_hash TEXT UNIQUE,
  karma       INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  avatar_url  TEXT,
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Federation: repos (local, not GitHub-bound)
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repos (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name              TEXT NOT NULL,
  description       TEXT,
  path              TEXT,
  stage             TEXT DEFAULT 'seed' CHECK (stage IN ('seed','growth','established','mature')),
  ownership_model   TEXT DEFAULT 'solo' CHECK (ownership_model IN ('solo','guild','open')),
  agent_access      TEXT DEFAULT 'public',
  min_karma         INTEGER DEFAULT 0,
  is_private        INTEGER DEFAULT 0,
  consensus_threshold REAL DEFAULT 0.66,
  min_reviews       INTEGER DEFAULT 1,
  human_review_weight REAL DEFAULT 1.5,
  contributor_count INTEGER DEFAULT 0,
  patch_count       INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',
  metadata          TEXT DEFAULT '{}',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Access control
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo_access (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id      TEXT NOT NULL REFERENCES repos(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  access_level TEXT DEFAULT 'read' CHECK (access_level IN ('none','read','write','maintain','admin')),
  expires_at   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(repo_id, agent_id)
);

CREATE TABLE IF NOT EXISTS maintainers (
  id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id   TEXT NOT NULL REFERENCES repos(id),
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  role      TEXT DEFAULT 'maintainer' CHECK (role IN ('owner','maintainer')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(repo_id, agent_id)
);

CREATE TABLE IF NOT EXISTS branch_rules (
  id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id            TEXT NOT NULL REFERENCES repos(id),
  branch_pattern     TEXT NOT NULL,
  direct_push        TEXT DEFAULT 'maintainers' CHECK (direct_push IN ('none','maintainers','all')),
  required_approvals INTEGER DEFAULT 1,
  require_tests_pass INTEGER DEFAULT 0,
  priority           INTEGER DEFAULT 0,
  created_at         TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Patches & reviews (coordination) — v1 only, replaced by streams in v2
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patches (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  author_id     TEXT NOT NULL REFERENCES agents(id),
  title         TEXT NOT NULL,
  description   TEXT,
  source_branch TEXT,
  target_branch TEXT DEFAULT 'main',
  status        TEXT DEFAULT 'open' CHECK (status IN ('open','merged','closed','draft')),
  diff_summary  TEXT,
  metadata      TEXT DEFAULT '{}',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patch_reviews (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patch_id    TEXT NOT NULL REFERENCES patches(id),
  reviewer_id TEXT NOT NULL REFERENCES agents(id),
  verdict     TEXT CHECK (verdict IN ('approve','request_changes','comment')),
  feedback    TEXT,
  tested      INTEGER DEFAULT 0,
  is_human    INTEGER DEFAULT 0,
  reviewed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(patch_id, reviewer_id)
);

-- ────────────────────────────────────────────────────────────────
-- Tasks / bounties
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id     TEXT NOT NULL REFERENCES repos(id),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','completed','cancelled','expired')),
  priority    TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  amount      INTEGER DEFAULT 0,
  labels      TEXT DEFAULT '[]',
  difficulty  TEXT,
  created_by  TEXT REFERENCES agents(id),
  expires_at  TEXT,
  completed_at TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_claims (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','submitted','approved','rejected','abandoned')),
  patch_id        TEXT REFERENCES patches(id),
  submission_notes TEXT,
  submitted_at    TEXT,
  reviewed_by     TEXT REFERENCES agents(id),
  reviewed_at     TEXT,
  review_notes    TEXT,
  claimed_at      TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Council governance
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo_councils (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id           TEXT UNIQUE NOT NULL REFERENCES repos(id),
  min_karma         INTEGER DEFAULT 1000,
  min_contributions INTEGER DEFAULT 5,
  min_members       INTEGER DEFAULT 3,
  max_members       INTEGER DEFAULT 9,
  standard_quorum   INTEGER DEFAULT 2,
  critical_quorum   INTEGER DEFAULT 3,
  status            TEXT DEFAULT 'forming' CHECK (status IN ('forming','active','dissolved')),
  term_limit_months INTEGER DEFAULT 6,
  election_interval_days INTEGER DEFAULT 90,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS council_members (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  council_id      TEXT NOT NULL REFERENCES repo_councils(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  role            TEXT DEFAULT 'member' CHECK (role IN ('chair','member')),
  votes_cast      INTEGER DEFAULT 0,
  proposals_made  INTEGER DEFAULT 0,
  term_expires_at TEXT,
  joined_at       TEXT DEFAULT (datetime('now')),
  UNIQUE(council_id, agent_id)
);

CREATE TABLE IF NOT EXISTS council_proposals (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  council_id       TEXT NOT NULL REFERENCES repo_councils(id),
  title            TEXT NOT NULL,
  description      TEXT,
  proposal_type    TEXT NOT NULL,
  proposed_by      TEXT NOT NULL REFERENCES agents(id),
  quorum_required  INTEGER DEFAULT 2,
  votes_for        INTEGER DEFAULT 0,
  votes_against    INTEGER DEFAULT 0,
  votes_abstain    INTEGER DEFAULT 0,
  status           TEXT DEFAULT 'open' CHECK (status IN ('open','passed','rejected','expired')),
  action_data      TEXT DEFAULT '{}',
  executed         INTEGER DEFAULT 0,
  executed_at      TEXT,
  execution_result TEXT,
  expires_at       TEXT,
  resolved_at      TEXT,
  proposed_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS council_votes (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  proposal_id TEXT NOT NULL REFERENCES council_proposals(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  vote        TEXT NOT NULL CHECK (vote IN ('for','against','abstain')),
  comment     TEXT,
  voted_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(proposal_id, agent_id)
);

-- ────────────────────────────────────────────────────────────────
-- Stage progression history
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stage_history (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo_id           TEXT NOT NULL REFERENCES repos(id),
  from_stage        TEXT NOT NULL,
  to_stage          TEXT NOT NULL,
  contributor_count INTEGER,
  patch_count       INTEGER,
  maintainer_count  INTEGER,
  transitioned_at   TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Activity log
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id    TEXT REFERENCES agents(id),
  event_type  TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_repo_access_lookup ON repo_access(repo_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_maintainers_lookup ON maintainers(repo_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_patches_repo       ON patches(repo_id);
CREATE INDEX IF NOT EXISTS idx_patches_author     ON patches(author_id);
CREATE INDEX IF NOT EXISTS idx_reviews_patch      ON patch_reviews(patch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_repo         ON tasks(repo_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_claims_task        ON task_claims(task_id);
CREATE INDEX IF NOT EXISTS idx_claims_agent       ON task_claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_proposals_council  ON council_proposals(council_id);
CREATE INDEX IF NOT EXISTS idx_votes_proposal     ON council_votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent     ON activity_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_activity_type      ON activity_log(event_type);
`;

/**
 * v2 migration — git-cascade integration.
 *
 * - Adds merge_mode and buffer fields to repos
 * - Adds stream_id to patch_reviews (replacing patch_id as primary ref)
 * - Adds stream_id to task_claims (replacing patch_id)
 * - Drops patches table (streams replace patches)
 */
export const migrationV2 = `
-- ── Schema version tracking ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- ── Repos: add merge_mode and buffer fields ─────────────────────
ALTER TABLE repos ADD COLUMN merge_mode TEXT DEFAULT 'review'
  CHECK (merge_mode IN ('swarm','review','gated'));

ALTER TABLE repos ADD COLUMN buffer_branch TEXT DEFAULT 'buffer';
ALTER TABLE repos ADD COLUMN promote_target TEXT DEFAULT 'main';
ALTER TABLE repos ADD COLUMN auto_promote_on_green INTEGER DEFAULT 0;
ALTER TABLE repos ADD COLUMN auto_revert_on_red INTEGER DEFAULT 1;
ALTER TABLE repos ADD COLUMN stabilize_command TEXT;

-- ── patch_reviews: add stream_id, review_block_id ───────────────
-- SQLite doesn't support DROP CONSTRAINT, so we recreate the table.
CREATE TABLE IF NOT EXISTS patch_reviews_v2 (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  stream_id       TEXT,
  review_block_id TEXT,
  patch_id        TEXT,
  reviewer_id     TEXT NOT NULL REFERENCES agents(id),
  verdict         TEXT CHECK (verdict IN ('approve','request_changes','comment')),
  feedback        TEXT,
  tested          INTEGER DEFAULT 0,
  is_human        INTEGER DEFAULT 0,
  reviewed_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(stream_id, reviewer_id)
);

INSERT OR IGNORE INTO patch_reviews_v2 (id, patch_id, reviewer_id, verdict, feedback, tested, is_human, reviewed_at)
  SELECT id, patch_id, reviewer_id, verdict, feedback, tested, is_human, reviewed_at FROM patch_reviews;

DROP TABLE IF EXISTS patch_reviews;
ALTER TABLE patch_reviews_v2 RENAME TO patch_reviews;

-- ── task_claims: add stream_id ──────────────────────────────────
ALTER TABLE task_claims ADD COLUMN stream_id TEXT;

-- ── Indexes for new columns ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_reviews_stream ON patch_reviews(stream_id);
CREATE INDEX IF NOT EXISTS idx_claims_stream ON task_claims(stream_id);

-- ── Record migration ────────────────────────────────────────────
INSERT INTO schema_version (version) VALUES (2);
`;

// Migration V3: sync_queue for offline Mode B event queuing
const migrationV3 = `
-- ── sync_queue: offline event queue for Mode B ──────────────────
CREATE TABLE IF NOT EXISTS sync_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO schema_version (version) VALUES (3);
`;

/** All migrations in order. */
export const migrations = [
  { version: 1, sql: schemaV1 },
  { version: 2, sql: migrationV2 },
  { version: 3, sql: migrationV3 },
];
