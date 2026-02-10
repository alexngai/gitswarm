# Cross-Level Architecture Fixes

This document describes fixes to friction points between gitswarm's three operational levels (CLI/local, web server, repo-level config) that were identified through a full-stack architecture review.

*Date: 2026-02-10*

---

## Overview

gitswarm operates at three interoperable levels:

1. **CLI/Local** (`cli/`) — standalone federation with SQLite and git-cascade
2. **Web Server** (`src/`) — centralized API with PostgreSQL, Redis, and GitHub integration
3. **Repo-Level** (`.gitswarm/`) — YAML config files committed to the repository

These levels were developed somewhat in isolation. When agents operate across multiple levels (e.g., CLI in Mode B syncing with the server), several integration seams caused incorrect behavior or silent failures. This document covers the four highest-priority fixes.

---

## Fix #11: Council `merge_stream` Executes Actual Merge

**File:** `src/services/council-commands.js`

### Problem

When a council proposal of type `merge_stream` passed:

- **CLI:** Called `federation.mergeToBuffer()` → actual git merge happened
- **Server:** Only ran `UPDATE gitswarm_streams SET review_status = 'approved'` → no merge

A user creating a `merge_stream` council proposal on the server would see the vote pass but the stream never actually merge.

### Fix

`executeMergeStream()` now:

1. Marks the stream as `review_status = 'approved'` (unchanged)
2. Calls `getBackendForRepo(repoId)` to get the appropriate backend (GitHub API or cascade)
3. Calls `backend.mergePullRequest()` to perform the actual merge
4. Records the merge in `gitswarm_merges`
5. Updates the stream status to `merged`

If the backend merge fails (e.g., merge conflict), the method returns `{ executed: false, status: 'approved_pending_merge' }` instead of throwing. This allows the CLI or a retry to pick up the approved-but-unmerged stream.

The same pattern was applied to `executeRevertStream()` and `executePromote()`:

- **`executeRevertStream`** now queries the repo's `git_backend` to determine if a server-side revert is possible (cascade backend) or if the DB status flag is the primary signal (GitHub backend, where reverts require creating a revert PR).
- **`executePromote`** now queries the repo config (`buffer_branch`, `promote_target`, `git_backend`), records the promotion, and for cascade-backend repos attempts the actual `git merge --ff-only`.

### Behavioral Change

| Proposal Type | Before | After |
|---------------|--------|-------|
| `merge_stream` | DB flag only | Backend merge + DB records |
| `revert_stream` | DB flag only | DB flag + cascade revert (when available) |
| `promote` | DB flag only | DB record + cascade ff (when available) |

---

## Fix #15: Consensus Check Against Stale Data

**Files:** `cli/src/sync-client.js`, `cli/src/federation.js`

### Problem

In Mode B, `mergeToBuffer()` flushes the sync queue (pushing local reviews to the server) then asks the server for consensus. If the flush partially failed — for example, 2 of 5 reviews failed to sync due to a transient error — the consensus check would evaluate against incomplete data. This could produce false positives (merge approved with insufficient reviews) or false negatives.

The flush error was swallowed silently:

```js
try { await this.sync.flushQueue(); } catch { /* Non-fatal */ }
```

### Fix

**`flushQueue()` now returns structured results:**

```js
{ flushed: 3, remaining: 2, failedTypes: ['review', 'submit_review'] }
```

The `failedTypes` array contains the event types that failed to sync, including events after the break point that were never attempted (since the batch processor stops at the first error to preserve ordering).

**`mergeToBuffer()` now blocks on review-critical failures:**

```js
const REVIEW_CRITICAL_TYPES = ['review', 'submit_review'];
if (flushResult?.failedTypes?.some(t => REVIEW_CRITICAL_TYPES.includes(t))) {
  throw new Error('Cannot check consensus: review event(s) failed to sync...');
}
```

Non-review events failing (commits, activity logs) do **not** block the merge — those are informational and don't affect consensus evaluation.

### Behavioral Change

| Scenario | Before | After |
|----------|--------|-------|
| Flush succeeds fully | Merge proceeds | Merge proceeds (unchanged) |
| Flush fails on review event | Merge proceeds with stale consensus | **Merge blocked** with clear error |
| Flush fails on non-review event | Merge proceeds | Merge proceeds (unchanged) |
| Server unreachable for flush | Merge proceeds to consensus check | Merge proceeds to consensus check (unchanged — handled there) |

---

## Fix #2: Gated Mode Enforcement in Mode B

**File:** `cli/src/federation.js`

### Problem

When `merge_mode: gated` is set on a repo, the intent is that merges require elevated approval (maintainer status, potentially human sign-off). The CLI checked this:

```js
if (mode === 'gated') {
  const { isMaintainer } = await this.permissions.isMaintainer(agentId, repo.id);
  if (!isMaintainer) throw new Error('...');
}
```

This is a local-only check. In Mode B, the server has richer gating policies (the `require_human_approval` and `human_review_weight` fields on the repo, maintainer status verified against the server's authoritative data, etc.). The CLI bypassed all of these by only checking the local SQLite.

### Fix

In Mode B (when `this.sync` is available), gated merges now delegate to the server's merge-request endpoint:

```js
if (mode === 'gated') {
  if (this.sync) {
    const approval = await this.sync.requestMerge(repo.id, streamId);
    if (!approval.approved) throw new Error('server denied merge...');
    // Skip local consensus check — requestMerge already validated it
  } else {
    // Mode A: local maintainer check (unchanged)
  }
}
```

The server's `POST /gitswarm/repos/:repoId/streams/:streamId/merge-request` endpoint checks both gated permissions (`permissionService.canPerform(agentId, repoId, 'merge')`) and consensus, returning a structured `{ approved, consensus, bufferBranch }` response.

If the server is unreachable, the merge is **queued** (via `_queueEvent`) rather than falling through to a local check. This prevents a Mode B agent from bypassing server-enforced gating by going offline.

The consensus block condition was updated from:

```js
if (mode === 'review' || mode === 'gated')
```

to:

```js
if (mode === 'review' || (mode === 'gated' && !this.sync))
```

This avoids double-checking consensus for gated mode in Mode B (since `requestMerge` already checked it).

### Behavioral Change

| Mode | Merge Mode | Before | After |
|------|------------|--------|-------|
| A (local) | gated | Local maintainer check | Local maintainer check (unchanged) |
| B (server) | gated | Local maintainer check | **Server-side requestMerge** |
| B (offline) | gated | Local maintainer check | **Merge queued** until server available |
| A/B | review | Consensus check | Consensus check (unchanged) |
| A/B | swarm | No check | No check (unchanged) |

---

## Fix #7: Plugin Compatibility Warnings

**File:** `cli/src/federation.js`

### Problem

If a repo's `.gitswarm/plugins.yml` defined Tier 2 (AI-augmented) or Tier 3 (governance) plugins, and an agent ran in Mode A (local-only), those plugins would silently do nothing. The `checkPluginCompatibility()` method existed but was never called automatically.

Similarly, when `_fireBuiltinPlugins()` ran for a trigger event, plugins from `plugins.yml` that didn't match any local builtin were silently skipped — no log, no warning.

### Fix

**Automatic warnings on open:**

`Federation.open()` now calls `checkPluginCompatibility()` and prints warnings to stderr:

```
[gitswarm] warning: Tier 2 (AI-augmented) plugins in plugins.yml require a server connection to execute.
```

This runs every time the federation is opened, providing immediate feedback.

**Skipped-plugin logging at execution time:**

`_fireBuiltinPlugins()` now detects plugins.yml entries for the current trigger that have no local builtin handler and logs them via the activity service:

```js
event_type: 'plugins_skipped_no_server'
metadata: {
  trigger: 'stabilization_passed',
  skipped: 'issue-enrichment, consensus-merge',
  reason: 'Tier 2/3 plugins require a server connection',
}
```

This activity log entry is visible via `gitswarm log` and helps agents understand why certain plugins aren't firing.

### Behavioral Change

| Scenario | Before | After |
|----------|--------|-------|
| Mode A with Tier 2/3 plugins | Silent, nothing happens | Warning on open + activity log on trigger |
| Mode B with Tier 2/3 plugins | Silent (server handles them) | No warning (sync client present) |
| Mode A with only Tier 1 plugins | Normal execution | Normal execution (unchanged) |

---

## Testing

All fixes are covered by tests in `tests/unit/cross-level-friction.test.js`:

| Fix | Tests | Coverage |
|-----|-------|----------|
| #11 | 7 tests | Merge success/failure, approval before merge, revert, promote, promote with missing repo |
| #15 | 7 tests | Full success, review failure, empty queue, duplicates, break-point collection, individual fallback |
| #2 | 3 tests | requestMerge endpoint path, denial with consensus info, HTTP error propagation |
| #7 | 2 tests | Review-critical type identification, merge-block vs non-block scenarios |

Run with:

```bash
npx vitest run tests/unit/cross-level-friction.test.js
```

---

## Remaining Known Gaps (Lower Priority)

These were identified in the architecture review but deferred:

| # | Issue | Severity | Notes |
|---|-------|----------|-------|
| 5 | `plugins_enabled` field ownership conflict | Medium | CLI and server source it from different places |
| 6 | Server-owned fields not excluded on CLI config read | Medium | CLI could apply `stage`, `agent_access` from config.yml |
| 9 | Tier inference logic differs (substring vs prefix) | Low | Edge case with unusual trigger names |
| 10 | Builtin plugin actions hardcoded to GitHub API | Medium | Only matters for Mode C cascade repos |
| 12 | Council voting and stream consensus disconnected | Medium | Parallel governance paths — arguably by design |
| 13 | Partial batch sync failure can cause retry loops | Medium | Needs dead-letter queue for permanently invalid events |
| 16 | Stabilization is CLI-only | Medium | By design — compute happens locally |
