# Mergify-Inspired Improvements for GitSwarm

**Version**: 0.1.0-draft
**Date**: 2026-02-10
**Status**: RFC (Request for Comments)
**Scope**: Features and patterns from Mergify that can improve GitSwarm's merge pipeline, CI integration, and developer experience

---

## 1. Context

[Mergify](https://mergify.com) is a mature SaaS platform for automating the pull request lifecycle on GitHub. Its core products — merge queue, workflow automation, merge protections, and CI insights — address many of the same problems GitSwarm faces: how to safely merge concurrent contributions at scale.

This document identifies Mergify features that are relevant to GitSwarm's architecture and proposes concrete adaptations. Each proposal is grounded in GitSwarm's existing design (federation spec, git-cascade, trust modes, buffer model) and notes where the feature maps to existing primitives vs. requiring new ones.

### How to read this document

Each section follows the structure:

1. **What Mergify does** — the feature as Mergify implements it
2. **What GitSwarm has today** — existing primitives that relate
3. **Proposed design** — how to adapt the idea to GitSwarm
4. **API / config surface** — concrete changes to CLI, config, or programmatic API
5. **Open questions** — unresolved design choices

---

## 2. Speculative merge testing

### 2.1 What Mergify does

Mergify's flagship feature tests multiple queued PRs simultaneously via "speculative checks." It creates temporary branches representing cumulative merges:

- Draft #1: PR #1 alone on top of main
- Draft #2: PR #1 + PR #2 combined
- Draft #3: PR #1 + PR #2 + PR #3 combined

All drafts run CI in parallel. If Draft #2 fails, PR #2 is identified as the problem; PRs #1 and #3 are retested without it. Up to 128 parallel checks are supported.

### 2.2 What GitSwarm has today

- **git-cascade merge queue** (`gc_merge_queue`): Ordered merge processing, but streams merge to buffer one at a time.
- **Stabilization with bisect**: Post-merge quality — runs tests on buffer, bisects to find the breaking merge, auto-reverts. This is *reactive* (fix after break) rather than *preventive* (test before merge).
- **Stream dependencies** (`gc_dependencies`): Ordering constraints, but no speculative testing of combinations.

### 2.3 Proposed design

Add a **speculative merge pipeline** between consensus and buffer merge. When multiple streams reach consensus around the same time, instead of merging them one-by-one and relying on post-merge stabilization:

1. Create temporary speculative branches (managed by git-cascade) representing cumulative merges
2. Run the `stabilize_command` against each speculative branch in parallel
3. If all pass, fast-merge the batch to buffer
4. If one fails, identify the culprit via the cumulative structure (or bisect if ambiguous), reject it, and merge the rest

```
Streams ready for merge: A, B, C (in priority order)

Speculative branches:
  spec/1 = buffer + A
  spec/2 = buffer + A + B
  spec/3 = buffer + A + B + C

Run stabilize_command on all three in parallel.

Results:
  spec/1: green  → A is safe
  spec/2: red    → B is the problem
  spec/3: green  → C is fine (B's issue doesn't affect C)

Action: merge A and C to buffer, reject B with failure details.
```

**Relationship to existing stabilization**: Speculative testing is a *pre-merge gate*. Existing stabilization remains as a *post-merge safety net*. In swarm mode (where streams auto-merge without review), stabilization is the only quality mechanism — speculative testing doesn't apply. In review and gated modes, speculative testing runs after consensus but before buffer merge.

### 2.4 Config surface

```json
{
  "speculative_testing": {
    "enabled": true,
    "max_parallel": 3,
    "timeout_seconds": 600,
    "skip_in_swarm_mode": true
  }
}
```

CLI:
```
gitswarm config speculative_testing.enabled true
gitswarm config speculative_testing.max_parallel 3
```

Programmatic API:
```js
federation.speculativeTest(streamIds)  → SpeculativeResult[]
```

### 2.5 Open questions

- Should speculative testing reuse the existing `stabilize_command` or support a separate, lighter test command?
- How to handle speculative branches when streams have dependency constraints (parent must merge before child)?
- Resource limits: running N parallel test suites may overwhelm the local machine. Should there be a concurrency limit tied to available cores?

---

## 3. Batch merging with automatic bisection

### 3.1 What Mergify does

Groups multiple PRs into a single CI run (batch sizes up to 128). If the batch fails, Mergify bisects — splits the batch in half, retests each half recursively until the failing PR is isolated. Passing PRs merge; the culprit is ejected.

### 3.2 What GitSwarm has today

- **Stabilization bisect**: Already exists for post-merge failure diagnosis. Uses git-cascade operation history to binary search for the breaking merge.
- **Merge queue**: Processes streams one at a time.

### 3.3 Proposed design

Extend the merge queue to support **batch processing**. Instead of merging and testing streams individually:

1. Accumulate streams in the merge queue up to `batch_size` or `batch_max_wait_time`
2. Merge the entire batch to a temporary branch
3. Run `stabilize_command` once
4. If green: fast-forward buffer to the batch result
5. If red: bisect the batch (split in half, test each half, recurse) to isolate the failing stream(s)

This directly reduces CI costs — one test run for N streams instead of N test runs.

**Interaction with speculative testing**: Batching and speculative testing can combine. Instead of speculating per-stream, speculate per-batch. With `batch_size: 3` and `max_parallel: 2`:

```
Queue: A, B, C, D, E, F

Batch 1: A + B + C  (spec/1)
Batch 2: A + B + C + D + E + F  (spec/2)

Both run CI in parallel.
```

### 3.4 Config surface

```json
{
  "merge_queue": {
    "batch_size": 5,
    "batch_max_wait_seconds": 300,
    "bisect_on_failure": true
  }
}
```

CLI:
```
gitswarm config merge_queue.batch_size 5
gitswarm config merge_queue.batch_max_wait_seconds 300
```

### 3.5 Open questions

- Should batch composition respect stream dependencies? (Yes — dependent streams should be in the same batch or in dependency order across batches.)
- How does batching interact with priority? (High-priority streams should form their own batch and skip the wait timer.)
- Is batch bisection duplicative with existing stabilization bisect? (Partially — the existing bisect operates on the buffer's operation history post-merge. Batch bisect operates on a temporary branch pre-merge. Both use the same algorithm.)

---

## 4. Priority-based merge ordering

### 4.1 What Mergify does

PRs get priorities — numeric (1-10,000) or keywords (`low`, `medium`, `high`). Higher-priority PRs jump the queue. With `allow_checks_interruption: true`, a hotfix can cancel in-progress CI for lower-priority items.

### 4.2 What GitSwarm has today

- **Task priority** (`tasks.priority`): `low | medium | high | critical`. Already used in merge queue priority computation.
- **Priority computation** (federation spec Section 6.2): task priority + consensus timestamp + council directive. Already exists.
- **Council `reorder_queue` proposal**: Explicit priority override.

**Gap**: Priority exists for tasks but not directly for streams unattached to tasks. There's no mechanism to interrupt in-progress CI for higher-priority work.

### 4.3 Proposed design

Two additions:

**A. Stream-level priority**: Allow priority to be set directly on streams, not just inherited from tasks. This covers the case where a stream isn't task-driven but still needs priority (e.g., a hotfix pushed directly).

```sql
-- Add to gc_merge_queue or as a gitswarm overlay
ALTER TABLE gc_merge_queue ADD COLUMN priority_override INTEGER;
```

Priority resolution order:
1. Council `reorder_queue` directive (highest)
2. Stream `priority_override` (if set)
3. Linked task priority (if task-driven)
4. Consensus timestamp (tiebreaker)

**B. CI interruption for priority escalation**: When a critical-priority stream enters the merge queue while speculative/batch testing is running, optionally cancel the current test run and restart with the critical stream at the front.

```json
{
  "priority": {
    "allow_interruption": true,
    "interruption_threshold": "critical"
  }
}
```

### 4.4 CLI surface

```
gitswarm merge <stream> --priority critical --as <agent>
gitswarm queue reorder <stream> --priority 1 --as <agent>
```

### 4.5 Open questions

- Should priority interruption only apply to speculative/batch testing, or also to ongoing stabilization runs?
- Should there be a karma-based priority boost? (e.g., high-karma agents' streams get a small priority bump automatically.)

---

## 5. Two-phase merge conditions

### 5.1 What Mergify does

Separates `queue_conditions` (requirements to enter the queue) from `merge_conditions` (requirements to actually merge). A PR can be queued early with lightweight checks while expensive CI runs only when the PR reaches the front.

### 5.2 What GitSwarm has today

- **Single consensus gate**: `checkConsensus()` evaluates all conditions at once. A stream either has consensus or it doesn't.
- **Branch rules**: `required_approvals`, `require_tests_pass`, `consensus_threshold` — all checked simultaneously.

### 5.3 Proposed design

Split the merge gate into two phases:

**Phase 1 — Queue eligibility** (lightweight):
- Minimum review count met (e.g., at least 1 review, any verdict)
- No `request_changes` verdicts outstanding
- Basic lint/format checks pass (configurable)
- Agent has write permission

**Phase 2 — Merge readiness** (full):
- Full consensus threshold met
- All CI checks pass (via speculative testing or stabilize_command)
- No merge freeze active (see Section 7)
- Dependencies satisfied

The benefit: streams enter the queue earlier, enabling speculative testing to begin before full consensus. If a stream reaches the front of the queue but hasn't achieved full consensus yet, it waits at the front (doesn't block others behind it that are ready).

### 5.4 Config surface

```json
{
  "queue_conditions": {
    "min_reviews": 1,
    "no_changes_requested": true,
    "checks": ["lint"]
  },
  "merge_conditions": {
    "consensus_threshold": 0.66,
    "min_reviews": 2,
    "require_tests_pass": true
  }
}
```

### 5.5 API surface

```js
federation.checkQueueEligibility(streamId)  → { eligible: boolean, reasons: string[] }
federation.checkMergeReadiness(streamId)    → { ready: boolean, reasons: string[] }

// Replaces single checkConsensus for queue/merge decisions
// checkConsensus still exists for review mode consensus evaluation
```

### 5.6 Open questions

- Does this add meaningful value in swarm mode (where there's no review gate)? Probably not — this is primarily for review and gated modes.
- Should queue eligibility be configurable per trust mode, or is it always the same lightweight gate?

---

## 6. Monorepo scopes (path-based queue partitioning)

### 6.1 What Mergify does

Defines "scopes" that partition the merge queue by file paths. Changes to `frontend/` and `backend/` are tested and merged independently, so unrelated changes don't block each other.

### 6.2 What GitSwarm has today

- **Single merge queue per repo**: All streams compete for the same queue regardless of what files they touch.
- **No path-based partitioning**: The config is repo-scoped, not directory-scoped.

### 6.3 Proposed design

Allow repos to define **scopes** — named partitions of the codebase by file path. Each scope gets its own independent merge queue, speculative testing pipeline, and stabilize command.

```json
{
  "scopes": {
    "frontend": {
      "paths": ["web/**", "public/**"],
      "stabilize_command": "npm run test:frontend",
      "batch_size": 3
    },
    "backend": {
      "paths": ["src/**", "shared/**"],
      "stabilize_command": "npm run test:backend",
      "batch_size": 5
    },
    "infra": {
      "paths": ["docker-compose*.yml", "Dockerfile", "*.toml"],
      "stabilize_command": "docker compose build --dry-run",
      "batch_size": 1
    }
  }
}
```

**Scope assignment**: When a stream is enqueued, git-cascade computes the set of changed files (diff against buffer). GitSwarm matches those files against scope patterns:

- If all changed files match a single scope → stream is assigned to that scope's queue
- If changed files span multiple scopes → stream goes to a "cross-scope" queue that tests against all affected scopes
- If no scope matches → stream goes to the default (global) queue

**Independent merge**: Scopes merge to buffer independently. A backend change doesn't wait for a frontend batch to complete. Cross-scope changes wait for all affected scope queues.

### 6.4 Open questions

- How do cross-scope conflicts interact with scope-independent merging? (If a frontend and backend change both modify `shared/`, they're both cross-scope.)
- Should scopes have independent consensus thresholds and review teams? (Probably yes — this maps well to the guild ownership model where different maintainers own different parts.)
- What about nested scopes (`src/` and `src/api/`)? Longest match wins?

---

## 7. Merge protections and scheduled freezes

### 7.1 What Mergify does

- **Scheduled freezes**: CRON-based rules that prevent merges during configured windows (weekends, deploy windows, holidays)
- **Instant freeze**: One-command freeze for incident response
- **Bypass rules**: Specific PRs (e.g., labeled `hotfix`) can bypass freezes
- **Queue pause**: Suspend all queue operations (new entries allowed, but no processing)

### 7.2 What GitSwarm has today

- **Council governance**: Council can make decisions about merges, but no time-based freeze mechanism.
- **No scheduled protection rules**.
- **`auto_promote_on_green` / `auto_revert_on_red`**: Toggle-based, not schedule-based.

### 7.3 Proposed design

Add a **merge protection** layer between the merge queue and buffer merge execution.

**A. Freeze rules** (declarative, in config):

```json
{
  "merge_protections": {
    "scheduled_freezes": [
      {
        "name": "weekend-freeze",
        "schedule": "* * * * 6,0",
        "reason": "No merges on weekends"
      },
      {
        "name": "deploy-window",
        "schedule": "0-30 14 * * 1-5",
        "reason": "Deploy window: 2:00-2:30 PM weekdays"
      }
    ],
    "bypass_conditions": {
      "priority": "critical",
      "labels": ["hotfix"]
    }
  }
}
```

**B. Instant freeze** (imperative, via CLI/API):

```
gitswarm freeze --reason "Production incident" --as <agent>
gitswarm unfreeze --as <agent>
```

Only maintainers or council members can freeze/unfreeze. Freeze state is stored in the database, not config.

**C. Queue pause** (for CI outages, infrastructure issues):

```
gitswarm queue pause --reason "CI runner down"
gitswarm queue resume
```

Paused queue accepts new entries but doesn't process them. Resumes from where it left off.

### 7.4 Behavior during freeze

- Streams can still be committed, reviewed, and reach consensus
- Streams can enter the merge queue
- Merge queue processing is suspended (no merges to buffer)
- Stabilization still runs (to detect issues in buffer)
- Promotion to main is also frozen
- Bypass-eligible streams (matching `bypass_conditions`) skip the freeze

### 7.5 Open questions

- Should freezes be a council proposal type (`freeze_merges`) requiring quorum? Or should individual maintainers have freeze power?
- Should freeze history be stored in `activity_log` for audit?
- For the local CLI deployment, CRON-based schedules require a daemon or periodic check. Is this practical? Alternative: check schedule at merge time and reject if in freeze window.

---

## 8. CI insights and flaky test detection

### 8.1 What Mergify does

- **Flaky test detection**: Re-runs tests on the same commit multiple times. Inconsistent results are flagged as flaky.
- **AI-powered diagnosis**: Categorizes CI failures as infrastructure, network, or code issues.
- **Automatic job retry**: Re-runs only the failed jobs, not the entire pipeline.
- **CI dashboard**: Visualizes CI outcomes across repos with success rates, trends, and common failure patterns.

### 8.2 What GitSwarm has today

- **Stabilization result logging**: Green/red events in `activity_log`, but no analysis of *why* tests failed.
- **Auto-revert on red**: Reverts the breaking merge, but doesn't distinguish flaky failures from real ones. A flaky test causes an unnecessary revert and a critical-priority task assignment.
- **Prometheus metrics**: Exist but don't track CI-specific data (test pass rates, flake rates, etc.).

### 8.3 Proposed design

**A. Flaky test detection via retry-on-red**:

Before auto-reverting a breaking merge, re-run the stabilize command N times. If the result is inconsistent (some green, some red), flag the failure as flaky rather than reverting.

```json
{
  "stabilization": {
    "flaky_detection": {
      "enabled": true,
      "retry_count": 3,
      "flaky_threshold": 0.5
    }
  }
}
```

Behavior:
1. Stabilize runs → red
2. Re-run up to `retry_count` times on the same buffer HEAD
3. If >= `flaky_threshold` of runs are green → flag as flaky, do NOT revert
4. If consistently red → proceed with bisect and revert as normal
5. Log flaky detection result with test output diffs

**B. Stabilization history table**:

```sql
stabilization_runs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER REFERENCES repos(id),
  buffer_commit TEXT,
  result TEXT,          -- 'green' | 'red' | 'flaky' | 'timeout'
  duration_ms INTEGER,
  output TEXT,          -- captured stdout/stderr
  retry_of INTEGER,    -- self-reference for flaky retries
  created_at TEXT
)
```

**C. CI metrics** (exposed via existing Prometheus endpoint or `gitswarm status`):

- Stabilization pass rate (last 24h, 7d, 30d)
- Flaky rate (what % of failures are identified as flaky)
- Mean time to stabilize
- Most common failure patterns (file paths, test names)
- Per-agent breakage rate (which agents' merges most often cause red)

### 8.4 CLI surface

```
gitswarm stabilize --retries 3           # explicit flaky detection
gitswarm ci-stats                        # show CI metrics
gitswarm ci-stats --agent <name>         # per-agent stats
```

### 8.5 Open questions

- Should flaky test data influence agent karma? (e.g., if an agent's merge triggers a flaky test but doesn't actually break anything, karma shouldn't be penalized.)
- Should there be a "known flaky tests" list that skips certain test failures entirely?
- For local CLI deployment, where does test output go? File-based logs in `.gitswarm/logs/`?

---

## 9. Cross-stream dependencies (`depends-on`)

### 9.1 What Mergify does

PRs declare dependencies on other PRs (even cross-repo) via `Depends-On:` headers in the PR body. Mergify waits until all dependencies are merged before merging the dependent PR.

### 9.2 What GitSwarm has today

- **Stream dependencies** (`gc_dependencies`): git-cascade already supports parent/child/fork relationships between streams. If Agent B forks from Agent A's stream, A must merge before B.
- **Dependency-driven merge ordering**: The merge queue respects the dependency DAG.

**Gap**: Dependencies are implicit (created by forking). There's no way to declare a dependency on a stream you didn't fork from. And there's no cross-repo dependency support.

### 9.3 Proposed design

**A. Explicit stream dependencies**:

Allow agents to declare dependencies without forking:

```
gitswarm workspace create --as agent-B --depends-on stream-A
# Already supported (creates fork dependency)

gitswarm depend --stream <my-stream> --on <other-stream> --as <agent>
# NEW: declare dependency without forking (no content inheritance)
```

This creates a `gc_dependencies` entry with `relationship: 'depends_on'` (vs. existing `fork`, `child`). The merge queue treats it identically — the depended-on stream must merge first.

**B. Cross-repo dependencies** (future, web app only):

For the web app deployment where GitSwarm manages multiple repos:

```json
{
  "dependencies": [
    { "repo": "shared-utils", "stream": "feature-x" }
  ]
}
```

The merge queue for the current repo waits until the referenced stream in the other repo is merged to its buffer. Requires cross-repo event notification (webhook or polling).

### 9.4 Open questions

- Should explicit dependencies be bidirectional? (If A depends on B, does B know about it?)
- How to handle circular dependencies? (Reject at declaration time.)
- For cross-repo dependencies, what happens if the depended-on stream is rejected? (Notify the dependent stream's agent, suggest re-evaluation.)

---

## 10. Comment-based commands (ChatOps)

### 10.1 What Mergify does

`@Mergifyio rebase`, `@Mergifyio queue`, `@Mergifyio backport <branch>` — commands invocable directly from GitHub PR comments.

### 10.2 What GitSwarm has today

- **CLI commands**: Full command set via `gitswarm` CLI.
- **Programmatic API**: `Federation` class for embedding in agent frameworks.
- **GitHub webhook handler**: Receives `push` and `pull_request` events.
- **No comment-based command interface**.

### 10.3 Proposed design

For the web app deployment (where GitSwarm has a GitHub App installed), add a webhook handler for `issue_comment` events that parses `@gitswarm` commands in PR comments.

**Supported commands**:

| Comment | Action |
|---|---|
| `@gitswarm review approve` | Submit approving review |
| `@gitswarm review request_changes` | Submit change request |
| `@gitswarm merge` | Add stream to merge queue (if consensus met) |
| `@gitswarm priority critical` | Set stream priority |
| `@gitswarm freeze` | Freeze merges (maintainer only) |
| `@gitswarm unfreeze` | Unfreeze merges (maintainer only) |
| `@gitswarm status` | Post a comment with merge queue status |
| `@gitswarm stabilize` | Trigger stabilization run |

**Agent identity resolution**: Map the GitHub user or bot posting the comment to a registered GitSwarm agent (via GitHub username stored in agent metadata).

### 10.4 Open questions

- Should this be limited to the web app, or should the local CLI also support a "watch comments" mode?
- How to handle commands from unknown GitHub users (not registered as agents)?
- Rate limiting on comment commands to prevent spam.

---

## 11. Shared configuration inheritance

### 11.1 What Mergify does

The `extends` key in `.mergify.yml` imports configuration from a central repository, reducing duplication across an organization's repos.

### 11.2 What GitSwarm has today

- **Per-repo config**: `.gitswarm/config.json` is self-contained per repo.
- **Platform org**: `gitswarm-public` has platform-wide policies, but they're enforced server-side, not via config inheritance.

### 11.3 Proposed design

Allow `.gitswarm/config.json` to extend a base configuration:

```json
{
  "extends": "gitswarm-public/default-config",
  "merge_mode": "review",
  "consensus_threshold": 0.75
}
```

Resolution:
1. Fetch base config from the referenced repo (via git clone or GitHub API)
2. Deep-merge with local config (local values override base)
3. Cache the base config with a TTL

**Use cases**:
- Org-wide governance policies (consensus thresholds, review requirements)
- Shared stabilize commands and CI configuration
- Consistent merge protection schedules across repos

### 11.4 Open questions

- How to handle base config updates? (Polling? Webhook? Manual refresh?)
- Should base configs be versioned (pinned to a commit/tag)?
- For local CLI, how to fetch remote config without network? (Cache on init, refresh on explicit command.)

---

## 12. Richer condition language

### 12.1 What Mergify does

Rich, declarative conditions in YAML:
- `#approved-reviews-by >= 2` — count-based
- `files~=^docs/` — file path regex matching
- `check-success = CI` — CI check status
- `author = dependabot[bot]` — author matching
- `label = hotfix` — label matching
- `base = main` — target branch matching
- Boolean AND (list = all must match), OR (list of lists), NOT (`-condition`)

### 12.2 What GitSwarm has today

- **Branch rules**: `branch_pattern`, `required_approvals`, `require_tests_pass`, `consensus_threshold` — structured fields, not a general condition language.
- **Task labels**: String array, but no label-based automation.
- **Trust modes**: `swarm | review | gated` — coarse-grained.

### 12.3 Proposed design

Add an **automation rules** system to `.gitswarm/config.json`. Rules define conditions and actions, evaluated when stream state changes (new commit, review submitted, consensus reached, etc.).

```json
{
  "automation_rules": [
    {
      "name": "auto-approve-docs",
      "conditions": {
        "files_match": "^docs/",
        "agent_karma_gte": 500
      },
      "actions": {
        "auto_approve": true,
        "set_priority": "low"
      }
    },
    {
      "name": "require-extra-review-for-config",
      "conditions": {
        "files_match": "^(\\.gitswarm/|config\\.)",
      },
      "actions": {
        "override_min_reviews": 3,
        "override_consensus_threshold": 0.9
      }
    },
    {
      "name": "fast-track-hotfix",
      "conditions": {
        "task_priority": "critical"
      },
      "actions": {
        "set_priority": "critical",
        "override_min_reviews": 1,
        "bypass_freeze": true
      }
    }
  ]
}
```

**Available conditions**:

| Condition | Type | Description |
|---|---|---|
| `files_match` | regex | Stream's changed files match pattern |
| `files_not_match` | regex | Stream's changed files don't match |
| `agent_name` | string | Committing agent's name |
| `agent_karma_gte` | number | Agent's karma >= value |
| `task_priority` | string | Linked task's priority |
| `task_labels` | string[] | Linked task has all listed labels |
| `review_count_gte` | number | Number of reviews >= value |
| `scope` | string | Stream's computed scope (from Section 6) |

**Available actions**:

| Action | Type | Description |
|---|---|---|
| `auto_approve` | boolean | Auto-submit an approving review |
| `set_priority` | string/number | Override stream priority |
| `override_min_reviews` | number | Change required review count |
| `override_consensus_threshold` | number | Change consensus threshold |
| `bypass_freeze` | boolean | Exempt from merge freeze |
| `assign_reviewers` | string[] | Request reviews from specific agents |
| `add_labels` | string[] | Add labels to the task |

### 12.4 Open questions

- Should rules be evaluated eagerly (on every state change) or lazily (on queue entry / merge attempt)?
- How do rule-based overrides interact with council directives? (Council should always take precedence.)
- Should rules support OR/NOT logic, or is AND-only sufficient for the first version?

---

## 13. Summary and prioritization

| # | Feature | Complexity | Impact | Priority | Applies to |
|---|---|---|---|---|---|
| 2 | Speculative merge testing | High | High | P0 | Review, Gated modes |
| 3 | Batch merging + bisection | Medium | High | P0 | All modes |
| 8 | CI insights + flaky detection | Medium | High | P0 | All modes |
| 7 | Merge protections / freezes | Low | Medium | P1 | All modes |
| 4 | Priority improvements | Low | Medium | P1 | Review, Gated modes |
| 5 | Two-phase merge conditions | Medium | Medium | P1 | Review, Gated modes |
| 12 | Richer condition language | Medium | Medium | P2 | Review, Gated modes |
| 6 | Monorepo scopes | Medium | Medium | P2 | Large repos |
| 9 | Cross-stream dependencies | Low | Low | P2 | Multi-agent |
| 10 | ChatOps commands | Low | Medium | P3 | Web app only |
| 11 | Shared config inheritance | Low | Low | P3 | Multi-repo orgs |

### Recommended implementation order

**Phase 1 — Merge pipeline quality** (P0):
1. Flaky test detection (smallest change, biggest immediate win — prevents unnecessary reverts)
2. Batch merging (extends existing merge queue with batching semantics)
3. Speculative merge testing (builds on batching, adds parallel pre-merge validation)

**Phase 2 — Merge governance** (P1):
4. Merge protections / freezes (standalone feature, no dependencies)
5. Priority improvements (extends existing priority system)
6. Two-phase merge conditions (refactors consensus checking)

**Phase 3 — Advanced automation** (P2-P3):
7. Automation rules / richer conditions
8. Monorepo scopes
9. Explicit cross-stream dependencies
10. ChatOps commands (web app)
11. Shared config inheritance

---

## 14. Appendix: Mergify vs GitSwarm architectural comparison

| Concern | Mergify | GitSwarm |
|---|---|---|
| **Unit of work** | Pull request | Stream (git-cascade) |
| **Merge target** | Base branch (main) directly | Buffer branch → main (two-tier) |
| **Quality gate** | Pre-merge (merge queue) | Post-merge (stabilization) + pre-merge (consensus) |
| **Trust model** | Uniform (all PRs follow same rules) | Configurable (swarm / review / gated) |
| **Conflict handling** | GitHub manages via merge commits | git-cascade defers conflicts, agents resolve |
| **Identity** | GitHub users | Registered agents with karma |
| **Governance** | Declarative YAML rules | Council system with proposals/votes |
| **Deployment** | SaaS (cloud-hosted) | Local CLI + web app |
| **CI integration** | Tight (reads GitHub check runs) | Loose (runs shell commands via stabilize_command) |
| **Scope** | Per-PR lifecycle automation | Full multi-agent coordination (tasks, reviews, governance) |

The key insight: Mergify optimizes the *merge pipeline* (queue → test → merge), while GitSwarm optimizes the *collaboration model* (identity → work → review → govern → merge). The Mergify-inspired features in this document bring merge pipeline sophistication to GitSwarm's already-strong collaboration model.
