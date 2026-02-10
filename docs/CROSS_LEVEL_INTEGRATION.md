# Cross-Level Integration: Design Requirements & Implementation Plan

> Addresses friction between the three GitSwarm operating levels: CLI (local), Web Server (platform), and Repo-Level (config-as-code).

## Table of Contents

- [Context](#context)
- [Issue 1: ID Format Incompatibility](#issue-1-id-format-incompatibility)
- [Issue 2: CLI Has No Organization Concept](#issue-2-cli-has-no-organization-concept)
- [Issue 3: Stream Data Model Gap in CLI](#issue-3-stream-data-model-gap-in-cli)
- [Issue 4: Config Source-of-Truth Divergence](#issue-4-config-source-of-truth-divergence)
- [Issue 5: Consensus Authority Split-Brain](#issue-5-consensus-authority-split-brain)
- [Issue 6: Offline Queue Has No Server Counterpart](#issue-6-offline-queue-has-no-server-counterpart)
- [Issue 7: Review Table Naming Confusion](#issue-7-review-table-naming-confusion)
- [Issue 8: Plugin System Is Server-Only](#issue-8-plugin-system-is-server-only)
- [Issue 9: Cascade Backend Dual-Database Drift](#issue-9-cascade-backend-dual-database-drift)
- [Issue 10: Missing Sync Flows Between Levels](#issue-10-missing-sync-flows-between-levels)
- [Implementation Sequence](#implementation-sequence)

---

## Context

GitSwarm operates at three levels that were developed somewhat independently:

| Level | Runtime | State Store | Git Operations | Primary Users |
|-------|---------|-------------|----------------|---------------|
| **CLI** (Mode A/B) | Node.js process | SQLite | git-cascade (local) | Developer agents on a machine |
| **Web Server** (Mode B/C) | Fastify + PostgreSQL | PostgreSQL + Redis | GitHub API or git-cascade (server-side) | HTTP agents, dashboards, GitHub webhooks |
| **Repo-Level** | GitHub Actions | `.gitswarm/` config files | GitHub API via MCP | Automated workflows, AI agents in Actions |

The levels are designed to be interoperable and optionally additive (A → A+B → A+B+C). This document identifies 10 friction points where the levels don't compose cleanly and proposes fixes for each.

### Design Principles (from existing specs)

These proposals respect the established architecture:

1. **git-cascade owns git, gitswarm owns policy** — no changes to this boundary
2. **Convergence over correctness** — accept eventual consistency, reject split-brain
3. **Lightweight by default** — hot path (agent commits) must stay fast
4. **Database-agnostic shared services** — `shared/permissions.js` and `shared/query-adapter.js` must continue to work on both SQLite and PostgreSQL

---

## Issue 1: ID Format Incompatibility

### Problem

CLI generates 32-character hex IDs via `lower(hex(randomblob(16)))`. Server generates 36-character UUIDs with dashes via `gen_random_uuid()`. Both are valid unique identifiers but are structurally incompatible — they can't be joined, compared, or used interchangeably.

This is a latent bug. It works today only because server columns use `VARCHAR(36)` which accepts 32-char strings, but any server code doing UUID validation, casting (`::uuid`), or joining CLI-generated IDs against server-generated IDs will silently produce empty results.

**Files involved:**
- `cli/src/store/schema.js` — `lower(hex(randomblob(16)))`
- `src/db/migrations/001_fresh_schema.sql` — `gen_random_uuid()`
- `shared/query-adapter.js` — passes IDs through without transformation

### Design Requirements

- R1.1: All IDs across CLI and server must be structurally identical so they can be used in joins and lookups without transformation.
- R1.2: Existing CLI databases must continue to work after the change (migration, not breaking change).
- R1.3: The ID format must be generatable offline without server coordination.

### Implementation

**Decision: Standardize on UUIDs with dashes (36-char).** UUIDs are the server's native format, are standard, and are equally easy to generate offline. Changing the CLI is less disruptive than changing the server (which has production data).

**Step 1 — CLI ID generation helper** (`shared/ids.js`, new file):

```javascript
import { randomUUID } from 'node:crypto';
export const generateId = () => randomUUID(); // 36-char UUID with dashes
```

Both CLI and server import from here. The server's `gen_random_uuid()` remains for DB-level defaults, but application-generated IDs use this shared function.

**Step 2 — CLI schema migration** (v4 in `cli/src/store/schema.js`):

Add a migration that converts existing 32-char hex IDs to UUID format by inserting dashes:

```sql
-- hex 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
-- becomes 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6'
UPDATE agents SET id =
  substr(id,1,8) || '-' || substr(id,9,4) || '-' || substr(id,13,4) || '-' ||
  substr(id,17,4) || '-' || substr(id,21,12)
WHERE length(id) = 32;
-- Repeat for all tables with TEXT id columns
```

**Step 3 — CLI default replacement:**

Replace all `lower(hex(randomblob(16)))` DEFAULT expressions in the schema with application-level `generateId()` calls, keeping the column as `TEXT PRIMARY KEY` (SQLite doesn't have a UUID type).

**Step 4 — Validation:** Add a `shared/ids.js:isValidId(id)` function that both sides use to validate IDs at sync boundaries.

**Scope:** ~15 tables in CLI schema need the migration. One new shared file. No server schema changes.

---

## Issue 2: CLI Has No Organization Concept

### Problem

The server requires every repo to belong to a `gitswarm_orgs` entity (`org_id` FK on `gitswarm_repos`). The CLI has a flat `repos` table with no org awareness. When a CLI agent connects to the server (Mode B), there's no mechanism to place its repos into the server's org hierarchy.

**Files involved:**
- `cli/src/store/schema.js` — no `orgs` table
- `src/db/migrations/001_fresh_schema.sql:170-180` — `gitswarm_orgs` with `owner_id` FK
- `cli/src/sync-client.js` — no org-related methods
- `shared/query-adapter.js` — `CLI_TABLES` maps `orgs` to `'orgs'` but no table exists

### Design Requirements

- R2.1: CLI repos must be placeable into the server org hierarchy during Mode B sync.
- R2.2: The CLI should remain usable without orgs in Mode A (purely local).
- R2.3: An agent connecting to a server for the first time must be able to register its repos without a manual org-creation step.

### Implementation

**Approach: Auto-org on first server sync.** When a CLI agent connects to a server and syncs a repo that has no org_id, the server creates a personal org for the agent (like GitHub's user namespace) and assigns the repo to it.

**Step 1 — Add `org_id` to CLI repos table** (v4 migration):

```sql
ALTER TABLE repos ADD COLUMN org_id TEXT;
```

Nullable — Mode A repos have no org. Set during Mode B sync.

**Step 2 — SyncClient: add `registerRepo()` method** (`cli/src/sync-client.js`):

```javascript
async registerRepo(repo) {
  // POST /gitswarm/repos/register
  // Server creates personal org if needed, assigns repo, returns { repoId, orgId }
  const result = await this._post('/gitswarm/repos/register', {
    name: repo.name,
    description: repo.description,
    cloneUrl: repo.clone_url,
    ownershipModel: repo.ownership_model,
    mergeMode: repo.merge_mode,
    // ... other settings
  });
  return result; // { id, org_id, ... }
}
```

**Step 3 — Server: add `POST /gitswarm/repos/register` endpoint** (`src/routes/gitswarm/index.js`):

- Authenticate agent
- Find or create personal org: `SELECT id FROM gitswarm_orgs WHERE owner_id = $1 AND is_personal = true`
- If none: `INSERT INTO gitswarm_orgs (name, owner_id, is_personal) VALUES ($agentName, $agentId, true)`
- Create repo under that org
- Return `{ id, org_id }`

**Step 4 — Add `is_personal` column to `gitswarm_orgs`** (server migration 005):

```sql
ALTER TABLE gitswarm_orgs ADD COLUMN is_personal BOOLEAN DEFAULT false;
```

**Step 5 — Federation.connectServer() calls registerRepo():**

In `cli/src/federation.js`, after connecting and authenticating, iterate local repos and call `registerRepo()` for any that lack an `org_id`. Store the returned `org_id` locally.

**Scope:** 1 new server endpoint. 1 new SyncClient method. 1 CLI migration column. 1 server migration column. ~20 lines in federation.js.

---

## Issue 3: Stream Data Model Gap in CLI

### Problem

CLI v2 migration deleted the `patches` table and added `stream_id` FKs to `patch_reviews` and `task_claims`, but never created a local `streams` table. Stream state lives entirely inside git-cascade's internal `gc_streams` table. The server has a full `gitswarm_streams` table with fields the CLI can't populate: `source`, `github_pr_number`, `parent_stream_id`, `review_status`.

The query adapter already maps the logical table `streams` → `gc_streams` for CLI. But `gc_streams` is owned by git-cascade and has a different schema than `gitswarm_streams`. The shared `PermissionService` queries `streams` to check consensus, which hits `gc_streams` — a table whose columns don't match what the service expects.

**Files involved:**
- `cli/src/store/schema.js` — v2 drops `patches`, no `streams` table
- `shared/query-adapter.js:CLI_TABLES` — maps `streams` → `gc_streams`
- `src/db/migrations/002_git_backend_and_stream_dedup.sql` — `gitswarm_streams` definition
- `cli/src/sync-client.js:syncStreamCreated()` — sends stream data to server

### Design Requirements

- R3.1: The CLI must have a queryable stream table that the shared `PermissionService` can use.
- R3.2: git-cascade's `gc_streams` must remain the authority for git-level stream state (branch, worktree, merge status).
- R3.3: The CLI stream table must include fields needed for server sync (`source`, `parent_stream_id`, `base_branch`).
- R3.4: Stream creation in the CLI must write to both `gc_streams` (via git-cascade API) and the new policy-level stream table.

### Implementation

**Approach: Add a policy-level `streams` table to CLI that mirrors the server's `gitswarm_streams` schema.** git-cascade continues to own `gc_streams` for git mechanics. The new `streams` table owns policy-level metadata. They share the same `stream_id`.

**Step 1 — CLI migration v4: create `streams` table:**

```sql
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  branch TEXT,
  base_branch TEXT DEFAULT 'main',
  parent_stream_id TEXT,
  task_id TEXT,
  status TEXT DEFAULT 'active',
  source TEXT DEFAULT 'cli',
  review_status TEXT DEFAULT 'pending',
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Step 2 — Update query adapter mapping:**

```javascript
// shared/query-adapter.js
CLI_TABLES.streams = 'streams'; // was 'gc_streams'
```

**Step 3 — Federation: dual-write on stream creation:**

In `cli/src/federation.js:createStream()`, after calling git-cascade's `createStream()`, also INSERT into the new `streams` table with the same ID. On status changes (submit, merge, abandon), update both.

**Step 4 — Backfill existing `gc_streams`:**

The v4 migration should populate `streams` from `gc_streams` for any existing data:

```sql
INSERT OR IGNORE INTO streams (id, repo_id, agent_id, name, branch, status, created_at)
  SELECT id, repo_id, agent_id, name, branch, status, created_at FROM gc_streams;
```

**Scope:** 1 new table in CLI. Query adapter one-line fix. ~30 lines in federation.js for dual-write. Migration backfill.

---

## Issue 4: Config Source-of-Truth Divergence

### Problem

Repo configuration has three independent sources with no reconciliation:

1. **`.gitswarm/config.yml`** in the repo — synced one-way to server via `ConfigSyncService` on push
2. **Server API** (`PATCH /gitswarm/repos/:id`) — allows direct updates that never flow back to the repo
3. **CLI `.gitswarm/config.json`** — local JSON config, independent of both

A server API update (e.g., changing `consensus_threshold` from 0.66 to 0.8) gets silently overwritten the next time someone pushes a commit touching `.gitswarm/`. The reverse (repo config reflecting server state) never happens.

**Files involved:**
- `src/services/config-sync.js:_syncRepoSettings()` — repo → server (one-way)
- `src/routes/gitswarm/index.js` — `PATCH /gitswarm/repos/:id` (server direct)
- `cli/src/federation.js` — reads local config

### Design Requirements

- R4.1: There must be a single, well-defined source of truth for each configuration scope.
- R4.2: Conflicting updates must be detected and surfaced, not silently dropped.
- R4.3: The repo-level config (`.gitswarm/config.yml`) should be the source of truth for settings that affect code behavior (merge mode, stabilize command, branch rules). The server API should be the source of truth for platform-level settings (agent access, karma thresholds, plugin enablement).
- R4.4: CLI must read from the same source of truth as the server when in Mode B.

### Implementation

**Approach: Split config into two scopes with clear ownership.**

**Repo-owned settings** (source of truth: `.gitswarm/config.yml`):
- `merge_mode`, `buffer_branch`, `promote_target`
- `auto_promote_on_green`, `auto_revert_on_red`, `stabilize_command`
- `consensus_threshold`, `min_reviews`, `human_review_weight`
- Branch rules (all)

**Server-owned settings** (source of truth: PostgreSQL, settable via API):
- `agent_access`, `min_karma`, `is_private`
- `ownership_model`, `stage`
- `plugins_enabled`
- `require_human_approval`, `human_can_force_merge`

**Step 1 — ConfigSyncService: only sync repo-owned fields:**

In `src/services/config-sync.js:_syncRepoSettings()`, restrict the field list to repo-owned settings. Remove `agent_access`, `min_karma`, `ownership_model` from the sync — these come from the server API only.

**Step 2 — Server API: reject writes to repo-owned fields when config.yml exists:**

In `PATCH /gitswarm/repos/:id`, check `gitswarm_repo_config.config_sha` — if non-null (repo has a config.yml), reject changes to repo-owned fields with HTTP 409:

```json
{
  "error": "conflict",
  "message": "These fields are managed by .gitswarm/config.yml. Update the file and push.",
  "fields": ["consensus_threshold", "merge_mode"]
}
```

If config.yml doesn't exist, allow all fields (backwards compatibility for repos not using config-as-code).

**Step 3 — CLI Mode B: fetch config from server:**

In `cli/src/sync-client.js`, add:

```javascript
async getRepoConfig(repoId) {
  return this._get(`/gitswarm/repos/${repoId}/config`);
}
```

In `federation.js:connectServer()`, after registering repos, fetch server config and merge server-owned fields into local state. Repo-owned fields come from local `.gitswarm/config.yml` (or `config.json`).

**Step 4 — Document the split:**

Add a comment block at the top of `config-sync.js` and in `.gitswarm/config.yml` template listing which fields are repo-owned vs server-owned.

**Scope:** Modify `_syncRepoSettings()` field list. Add guard in PATCH route (~15 lines). 1 new SyncClient method. Documentation.

---

## Issue 5: Consensus Authority Split-Brain

### Problem

When the CLI is connected to the server (Mode B), consensus checking falls back from server to local on any network error:

```javascript
// federation.js ~line 680
if (this.sync) {
  try {
    consensus = await this.sync.checkConsensus(repo.id, streamId);
  } catch {
    consensus = await this.permissions.checkConsensus(streamId, repo.id);
  }
}
```

If the server is intermittently unreachable, consensus authority flips between server and local. Since the review data may not be fully synced (offline queue hasn't flushed), local and server can reach different conclusions. An agent could get a local "consensus reached" during a network blip, merge to buffer, then sync the merge to a server that would have rejected it.

**Files involved:**
- `cli/src/federation.js:~680-688` — fallback logic
- `shared/permissions.js:checkConsensus()` — the consensus algorithm
- `cli/src/sync-client.js:checkConsensus()` — server call

### Design Requirements

- R5.1: Once a repo has been syncing with the server, the server must remain the consensus authority. Local fallback must not produce merges that the server would reject.
- R5.2: During transient outages, the CLI should queue the merge request rather than falling back to local consensus.
- R5.3: In Mode A (never connected to server), local consensus must continue to work as-is.
- R5.4: Explicit operator override (force-merge) must remain available for emergencies.

### Implementation

**Approach: Replace silent fallback with queue-or-block.**

**Step 1 — Track consensus authority per repo:**

Add a column to CLI `repos` table (v4 migration):

```sql
ALTER TABLE repos ADD COLUMN consensus_authority TEXT DEFAULT 'local';
-- Values: 'local' (Mode A), 'server' (Mode B, connected at least once)
```

Set to `'server'` on first successful `connectServer()` for that repo.

**Step 2 — Replace fallback logic in federation.js:**

```javascript
async checkConsensus(repo, streamId) {
  if (repo.consensus_authority === 'server' && this.sync) {
    try {
      return await this.sync.checkConsensus(repo.id, streamId);
    } catch (err) {
      // Don't fall back — queue the merge attempt
      return {
        reached: false,
        reason: 'server_unavailable',
        queued: true,
        message: 'Consensus check queued. Will retry when server is reachable.'
      };
    }
  }
  // Mode A: local consensus
  return this.permissions.checkConsensus(streamId, repo.id);
}
```

**Step 3 — Queue merge attempts:**

When `checkConsensus` returns `{ queued: true }`, the calling code in `mergeStream()` should queue a `merge_requested` event to `sync_queue` instead of proceeding with the merge. On next `flushQueue()`, the merge request goes to the server, which checks consensus and either approves (returning the merge commit) or rejects.

**Step 4 — SyncClient: add merge request to queue dispatch:**

In `_dispatchQueuedEvent()`, add a `merge_requested` event type that calls `requestMerge()` and, on approval, performs the local git merge.

**Scope:** 1 column migration. ~30 lines changed in federation.js. ~10 lines in sync-client.js dispatch. No server changes needed (the existing `POST /repos/:id/streams/:id/merge` already validates consensus).

---

## Issue 6: Offline Queue Has No Server Counterpart

### Problem

The CLI v3 migration adds `sync_queue` for offline event buffering, and `SyncClient.flushQueue()` replays events on reconnection. But:

1. **No acknowledgment** — the CLI deletes events from the queue after the HTTP call succeeds, but doesn't verify the server actually processed them (the server could 200 but fail to commit to DB).
2. **No deduplication** — if a flush partially succeeds (3 of 5 events sent, then network drops), retrying sends all 5 again. The server may create duplicate streams/commits.
3. **No server-side batch endpoint** — each queued event is replayed as an individual HTTP call, meaning a queue of 100 events triggers 100 sequential requests.
4. **No ordering guarantee across event types** — events are ordered by `created_at`, but two events with the same timestamp could replay in either order.

**Files involved:**
- `cli/src/store/schema.js` — v3 migration, `sync_queue` table
- `cli/src/sync-client.js:flushQueue()` — replay logic
- `cli/src/sync-client.js:_dispatchQueuedEvent()` — event router

### Design Requirements

- R6.1: The server must be able to accept and process batched event replays.
- R6.2: Events must be idempotent — replaying the same event twice must not create duplicate records.
- R6.3: Events must be acknowledged with a receipt that the CLI can use to safely delete from its queue.
- R6.4: Event ordering must be deterministic (timestamp + sequence number).

### Implementation

**Step 1 — Add sequence number to sync_queue** (CLI v4 migration):

```sql
-- sync_queue already has AUTOINCREMENT id, which serves as sequence.
-- Add a processed_at column for tracking:
ALTER TABLE sync_queue ADD COLUMN attempts INTEGER DEFAULT 0;
ALTER TABLE sync_queue ADD COLUMN last_error TEXT;
```

**Step 2 — Server: add batch sync endpoint** (`src/routes/gitswarm/index.js`):

```
POST /api/v1/gitswarm/sync/batch
```

Body:

```json
{
  "events": [
    { "seq": 1, "type": "stream_created", "data": { ... }, "created_at": "..." },
    { "seq": 2, "type": "commit", "data": { ... }, "created_at": "..." }
  ]
}
```

Response:

```json
{
  "results": [
    { "seq": 1, "status": "ok" },
    { "seq": 2, "status": "ok" },
    { "seq": 3, "status": "duplicate", "existing_id": "..." }
  ]
}
```

Processing:
- Wrap in a transaction
- For each event, attempt the operation
- On unique constraint violation → return `"duplicate"` (not an error)
- On real error → return `"error"` with message, stop processing remaining events (preserve ordering)

**Step 3 — Server: add deduplication keys to stream/commit tables:**

The server already has `UNIQUE(repo_id, branch)` on `gitswarm_streams` and `UNIQUE(stream_id, commit_hash)` on `gitswarm_stream_commits`. These serve as natural dedup keys. Ensure all event types have equivalent unique constraints:

- Reviews: `UNIQUE(stream_id, reviewer_id)` — already exists
- Stabilizations: add `UNIQUE(repo_id, buffer_commit)` if not present
- Promotions: add `UNIQUE(repo_id, from_commit, to_commit)` if not present

**Step 4 — SyncClient: replace `flushQueue()` with batch flush:**

```javascript
async flushQueue() {
  const events = this.store.query(
    'SELECT id, event_type, payload, created_at FROM sync_queue ORDER BY id ASC LIMIT 100'
  );
  if (!events.length) return { flushed: 0, remaining: 0 };

  const batch = events.map((e, i) => ({
    seq: e.id,
    type: e.event_type,
    data: JSON.parse(e.payload),
    created_at: e.created_at
  }));

  const { results } = await this._post('/gitswarm/sync/batch', { events: batch });

  // Delete successfully processed events
  const processed = results.filter(r => r.status === 'ok' || r.status === 'duplicate');
  for (const r of processed) {
    this.store.query('DELETE FROM sync_queue WHERE id = ?', [r.seq]);
  }

  const remaining = this.store.query('SELECT COUNT(*) as count FROM sync_queue');
  return { flushed: processed.length, remaining: remaining[0].count };
}
```

**Scope:** 2 columns added to CLI `sync_queue`. 1 new server endpoint (~80 lines). Rewrite `flushQueue()` (~30 lines). Possibly 1-2 unique constraints on server tables.

---

## Issue 7: Review Table Naming Confusion

### Problem

There are two independent review tables on the server:

1. `patch_reviews` — used by the legacy GitHub PR review flow (`src/routes/forges.js`, `src/routes/gitswarm/index.js` PR reviews endpoint)
2. `gitswarm_stream_reviews` — used by the stream-based review flow

The shared `PermissionService` queries the logical table `stream_reviews`, which the query adapter maps to `gitswarm_stream_reviews` (server) or `patch_reviews` (CLI). Reviews submitted through GitHub PRs go into `patch_reviews` on the server but never into `gitswarm_stream_reviews`. If a stream is linked to a GitHub PR, reviews on that PR don't count toward stream consensus.

**Files involved:**
- `shared/query-adapter.js` — `WEB_TABLES.stream_reviews = 'gitswarm_stream_reviews'`, `CLI_TABLES.stream_reviews = 'patch_reviews'`
- `src/routes/gitswarm/index.js` — PR review submission writes to `patch_reviews`
- `src/routes/webhooks.js` — GitHub PR review webhook writes to `patch_reviews`
- `shared/permissions.js:checkConsensus()` — queries `stream_reviews`

### Design Requirements

- R7.1: Reviews on a GitHub PR that is linked to a stream must count toward that stream's consensus.
- R7.2: The legacy `patch_reviews` table must continue to work for non-stream GitHub PRs (backwards compatibility).
- R7.3: The shared `PermissionService` must query a single, unified review source per stream.

### Implementation

**Approach: Bridge reviews from `patch_reviews` to `gitswarm_stream_reviews` when a PR-stream link exists.**

**Step 1 — Webhook handler: copy PR reviews to stream_reviews when linked:**

In `src/routes/webhooks.js`, when handling a `pull_request_review` event:

```javascript
// After inserting into patch_reviews...
// Check if this PR is linked to a stream
const stream = await db.query(
  'SELECT id FROM gitswarm_streams WHERE github_pr_number = $1 AND repo_id = $2',
  [prNumber, repoId]
);
if (stream.rows.length) {
  await db.query(
    `INSERT INTO gitswarm_stream_reviews (stream_id, reviewer_id, verdict, feedback, is_human, reviewed_at)
     VALUES ($1, $2, $3, $4, true, NOW())
     ON CONFLICT (stream_id, reviewer_id) DO UPDATE SET verdict = $3, feedback = $4, reviewed_at = NOW()`,
    [stream.rows[0].id, reviewerAgentId, verdict, feedback]
  );
}
```

**Step 2 — PR review route: same bridge logic:**

In `src/routes/gitswarm/index.js`, the `POST /repos/:id/pulls/:prNumber/reviews` handler should also write to `gitswarm_stream_reviews` when the PR is linked to a stream.

**Step 3 — CLI query adapter: fix the mapping:**

```javascript
// shared/query-adapter.js
CLI_TABLES.stream_reviews = 'patch_reviews'; // This is correct for CLI — CLI only has patch_reviews
// But ensure the CLI's patch_reviews schema has all fields that PermissionService expects
```

The CLI's `patch_reviews` table already has `stream_id`, `reviewer_id`, `verdict`, `feedback`, `is_human`, `tested` — these match what `PermissionService.checkConsensus()` queries. No CLI change needed.

**Scope:** ~20 lines in webhook handler. ~10 lines in PR review route. No schema changes. No CLI changes.

---

## Issue 8: Plugin System Is Server-Only

### Problem

The plugin engine (`src/services/plugin-engine.js`, 1216 lines) is entirely server-side. The CLI has zero awareness of plugins — it can't trigger them, query their status, or receive their results. If a CLI agent merges a stream that should trigger a builtin plugin (like `promote_buffer_to_main`), that plugin only fires if the merge event reaches the server and gets routed through the plugin engine. In offline mode, plugins never fire.

**Files involved:**
- `src/services/plugin-engine.js` — server-side only
- `src/services/config-sync.js` — syncs `.gitswarm/plugins.yml` to server
- `cli/src/federation.js` — no plugin awareness
- `cli/src/sync-client.js` — no plugin methods

### Design Requirements

- R8.1: CLI agents must be able to trigger builtin plugins (Tier 1 automations) locally in Mode A.
- R8.2: In Mode B, plugin execution should be delegated to the server when online, with a defined subset executable locally when offline.
- R8.3: The CLI must not need to implement the full plugin engine — only a lightweight executor for builtin actions.
- R8.4: Plugin results (e.g., "promotion succeeded") must be visible to CLI agents.

### Implementation

**Approach: Implement a minimal CLI plugin runner for Tier 1 builtins only. Tier 2 (AI) and Tier 3 (governance) remain server-only.**

The only Tier 1 plugins that make sense locally are:

| Plugin | Trigger | CLI Action |
|--------|---------|------------|
| `promote_buffer_to_main` | `stabilization_passed` | `gitCascade.promote()` |
| `auto_revert_on_red` | `stabilization_failed` | `gitCascade.revertLastMerge()` |
| `stale_stream_cleanup` | `schedule` (or manual) | `gitCascade.abandonStream()` for stale |

**Step 1 — CLI: add `plugins/builtins.js`:**

```javascript
export const BUILTIN_PLUGINS = {
  promote_buffer_to_main: {
    trigger: 'stabilization_passed',
    execute: async (federation, repo, event) => {
      if (!repo.auto_promote_on_green) return { skipped: true };
      return federation.promote(repo.id);
    }
  },
  auto_revert_on_red: {
    trigger: 'stabilization_failed',
    execute: async (federation, repo, event) => {
      if (!repo.auto_revert_on_red) return { skipped: true };
      return federation.revertBreakingStream(repo.id, event.breakingStreamId);
    }
  }
};
```

**Step 2 — Federation: fire builtins after relevant operations:**

```javascript
// After stabilization completes:
async afterStabilization(repo, result) {
  const trigger = result.passed ? 'stabilization_passed' : 'stabilization_failed';
  for (const [name, plugin] of Object.entries(BUILTIN_PLUGINS)) {
    if (plugin.trigger === trigger) {
      await plugin.execute(this, repo, result);
    }
  }
}
```

**Step 3 — SyncClient: add plugin status query:**

```javascript
async getPluginExecutions(repoId, { limit = 10 } = {}) {
  return this._get(`/gitswarm/repos/${repoId}/plugins/executions?limit=${limit}`);
}
```

**Step 4 — Server: ensure plugin engine fires on synced events:**

When the CLI syncs a `stabilization` event via the batch sync endpoint (Issue 6), the server should route it through the plugin engine. This already happens for webhook-triggered events; ensure the batch sync handler calls `pluginEngine.processEvent()` for each synced event.

**Scope:** 1 new CLI file (~60 lines). ~15 lines in federation.js. 1 new SyncClient method. Verify server batch sync triggers plugins.

---

## Issue 9: Cascade Backend Dual-Database Drift

### Problem

For Mode C repos, `GitCascadeManager` creates a per-repo SQLite sidecar (`.gitswarm-cascade.db`) alongside PostgreSQL. Buffer branch and promote target are stored in both databases. If PostgreSQL is updated via API (e.g., `buffer_branch` changed from `buffer` to `develop`), the SQLite tracker still points to the old value. There's no invalidation or re-sync.

**Files involved:**
- `src/services/git-cascade-manager.js:104-121` — SQLite init, stores buffer_branch
- `src/routes/gitswarm/index.js` — `PATCH /gitswarm/repos/:id` updates PostgreSQL
- `src/services/cascade-backend.js` — reads from both

### Design Requirements

- R9.1: PostgreSQL must be the single source of truth for repo settings in Mode C.
- R9.2: The SQLite sidecar must only store git-cascade-internal state (streams, worktrees, merge queue), not duplicated repo settings.
- R9.3: Updating repo settings via API must not require restarting the server or re-initializing the cascade manager.

### Implementation

**Approach: Stop caching repo settings in the SQLite sidecar. Read them from PostgreSQL on each operation.**

**Step 1 — GitCascadeManager: read settings from PostgreSQL, not SQLite:**

Replace direct SQLite reads of `buffer_branch` / `promote_target` with a PostgreSQL lookup:

```javascript
async getRepoSettings(repoId) {
  const result = await this.db.query(
    'SELECT buffer_branch, promote_target, auto_promote_on_green, auto_revert_on_red, stabilize_command FROM gitswarm_repos WHERE id = $1',
    [repoId]
  );
  return result.rows[0];
}
```

Every method that currently does `db.prepare('SELECT buffer_branch FROM ...').get()` on the SQLite sidecar should call `getRepoSettings()` instead.

**Step 2 — Pass PostgreSQL pool to GitCascadeManager:**

The constructor currently only takes `reposDir`. Add `db` parameter:

```javascript
constructor(reposDir = DEFAULT_REPOS_DIR, db = null) {
  this.db = db; // PostgreSQL pool
  // ...
}
```

Wire this up in `src/index.js` where the singleton is created.

**Step 3 — Remove duplicated columns from SQLite sidecar init:**

In `initRepo()`, stop creating/populating repo-settings columns in the sidecar. The sidecar's schema is owned by git-cascade (the `gc_` tables); gitswarm policy fields should not be there.

**Step 4 — Invalidate cached tracker on settings change:**

In the `PATCH /gitswarm/repos/:id` route, after updating PostgreSQL, call:

```javascript
if (gitCascadeManager.trackers.has(repoId)) {
  // No action needed — settings are read from PG on each operation
  // But if we cache settings in the future, invalidate here
}
```

Since we're reading from PG each time, no invalidation needed. But add a comment noting this is the invalidation point.

**Scope:** Modify `git-cascade-manager.js` constructor + 3-4 methods to read from PG instead of SQLite. Wire PG pool in `index.js`. Remove ~10 lines of sidecar init code.

---

## Issue 10: Missing Sync Flows Between Levels

### Problem

Several entity types that exist in both CLI and server have no sync implementation:

| Flow | Current State |
|------|---------------|
| CLI council operations → server | Not synced — `SyncClient` has no council methods |
| CLI stage progression → server | Not synced — `SyncClient` has no stage methods |
| Server tasks → CLI (pull) | Partial — `listTasks()` exists but no push notification |
| Server budget changes → CLI | Not synced — CLI has no budget concept |
| Plugin execution results → CLI | Not synced — CLI can't query plugin status |
| CLI stream abandonment → server | Implemented (`syncStreamAbandoned`) but not in queue dispatch |

**Files involved:**
- `cli/src/sync-client.js` — missing methods
- `cli/src/sync-client.js:_dispatchQueuedEvent()` — missing event types
- `cli/src/federation.js` — council/stage operations don't call sync

### Design Requirements

- R10.1: All state-changing operations in the CLI must be syncable to the server.
- R10.2: The server must be able to push critical updates (task assignments, access revocations) to connected CLI agents.
- R10.3: Sync methods must be idempotent and safe to retry.
- R10.4: Not all server features need CLI-side implementation — but the CLI must at minimum be able to report its operations and receive task/access updates.

### Implementation

**Step 1 — Add missing SyncClient methods:**

```javascript
// Council operations
async syncCouncilProposal(repoId, proposal) {
  return this._post(`/gitswarm/repos/${repoId}/council/proposals`, proposal);
}

async syncCouncilVote(repoId, proposalId, vote) {
  return this._post(`/gitswarm/repos/${repoId}/council/proposals/${proposalId}/votes`, vote);
}

// Stage progression
async syncStageProgression(repoId, { fromStage, toStage, metrics }) {
  return this._post(`/gitswarm/repos/${repoId}/stage`, { from_stage: fromStage, to_stage: toStage, metrics });
}

// Task submission (completing a claimed task)
async syncTaskSubmission(taskId, { streamId, notes }) {
  return this._post(`/gitswarm/tasks/${taskId}/submit`, { stream_id: streamId, submission_notes: notes });
}
```

**Step 2 — Add missing event types to queue dispatch:**

```javascript
// In _dispatchQueuedEvent():
case 'stream_abandoned':
  return this.syncStreamAbandoned(data.repoId, data.streamId, data.reason);
case 'council_proposal':
  return this.syncCouncilProposal(data.repoId, data.proposal);
case 'council_vote':
  return this.syncCouncilVote(data.repoId, data.proposalId, data.vote);
case 'stage_progression':
  return this.syncStageProgression(data.repoId, data);
case 'task_submission':
  return this.syncTaskSubmission(data.taskId, data);
```

**Step 3 — Federation: call sync methods from council/stage operations:**

In `cli/src/federation.js`, after `createProposal()`, `castVote()`, `progressStage()`:

```javascript
if (this.sync) {
  try {
    await this.sync.syncCouncilProposal(repo.id, proposal);
  } catch {
    this._queueEvent({ type: 'council_proposal', data: { repoId: repo.id, proposal } });
  }
}
```

**Step 4 — Server push via polling (pragmatic approach):**

Full WebSocket push to CLI agents is complex and the current WebSocket is browser-focused. Instead, add a polling endpoint the CLI can check periodically:

```javascript
// SyncClient
async pollUpdates(since) {
  return this._get(`/gitswarm/updates?since=${encodeURIComponent(since)}`);
}
```

Server endpoint returns recent events relevant to the agent:
- New task assignments
- Access grants/revocations
- Council proposals requiring their vote
- Plugin execution results

The CLI calls this on a configurable interval (default: 60s) when connected.

**Scope:** ~6 new SyncClient methods (~40 lines). ~30 lines in federation.js to wire sync calls. ~5 new cases in queue dispatch. 1 new server polling endpoint (~50 lines).

---

## Implementation Sequence

The issues have dependencies. Here is the recommended order:

```
Phase 1: Foundation (unblocks everything else)
├── Issue 1: ID Format — shared/ids.js + CLI migration v4
└── Issue 3: Stream Table — CLI migration v4 (same migration)

Phase 2: Sync Infrastructure (unblocks cross-level flows)
├── Issue 6: Batch Sync Endpoint — server endpoint + client rewrite
├── Issue 5: Consensus Split-Brain — federation.js guard + queue integration
└── Issue 7: Review Bridge — webhook handler fix

Phase 3: Config & State Consistency
├── Issue 4: Config Source-of-Truth — config-sync.js + API guard
├── Issue 9: Cascade Dual-DB — git-cascade-manager.js refactor
└── Issue 2: Org Concept — CLI column + server endpoint + federation wiring

Phase 4: Feature Completeness
├── Issue 10: Missing Sync Flows — SyncClient methods + federation wiring
└── Issue 8: CLI Plugin Runner — new file + federation hooks
```

### Phase 1 rationale
ID format and the stream table are in the same CLI migration (v4). They must land first because every subsequent change involves cross-level ID references and stream operations.

### Phase 2 rationale
The batch sync endpoint is the transport layer for all other sync improvements. Consensus split-brain depends on the queue working correctly. Review bridging is a small, independent server fix.

### Phase 3 rationale
Config and state fixes are independent of each other but depend on Phase 1 (correct IDs) and Phase 2 (working sync). The org concept depends on the server registration endpoint, which depends on working sync.

### Phase 4 rationale
Missing sync flows and CLI plugins are additive features that build on a working Phase 1-3 foundation. They can be implemented incrementally.

### Estimated scope per phase

| Phase | New Files | Modified Files | New Server Endpoints | CLI Migration |
|-------|-----------|---------------|---------------------|---------------|
| 1 | 1 (`shared/ids.js`) | 3 | 0 | v4 (ID + streams) |
| 2 | 0 | 4 | 1 (`/sync/batch`) | 0 |
| 3 | 0 | 5 | 1 (`/repos/register`) | 1 column each |
| 4 | 1 (`cli plugins`) | 3 | 1 (`/updates` poll) | 0 |
