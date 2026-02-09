# GitSwarm Federation — Design Specification

**Version**: 0.1.0-draft
**Date**: 2026-02-08
**Status**: Draft
**Scope**: Local-first multi-agent federation with configurable trust, built on git-cascade

---

## 1. Overview

GitSwarm Federation is a coordination layer for multi-agent software development. It enables multiple AI agents to work concurrently on a shared codebase with configurable trust and governance policies.

The system is built as a policy layer on top of [git-cascade](https://github.com/alexngai/git-cascade), which handles all git mechanics (streams, worktrees, merging, conflict deferral, change propagation). GitSwarm adds agent identity, permissions, task distribution, consensus, governance, and promotion gating.

### Design principles

1. **git-cascade owns git, gitswarm owns policy.** GitSwarm never calls `git` directly. Every git operation flows through git-cascade's API.
2. **Lightweight by default.** The hot path (agent commits code) should have near-zero coordination overhead. Governance is opt-in, not imposed.
3. **Trust is a spectrum.** The same architecture supports aligned local agents (swarm mode), peer-reviewed teams (review mode), and untrusted public contributors (gated mode). The difference is configuration, not code.
4. **Convergence over correctness.** Accept some turbulence during active development. Quality comes from periodic stabilization, not per-commit gating.
5. **Decentralized ordering.** Agents express merge ordering through stream dependencies rather than explicit voting on queue position.

---

## 2. Architecture

### 2.1 Layer diagram

```
┌──────────────────────────────────────────────────────┐
│                   gitswarm                            │
│  Policy: agents, permissions, tasks, consensus,       │
│          governance, promotion, stabilization          │
├──────────────────────────────────────────────────────┤
│                  git-cascade                          │
│  Mechanics: streams, worktrees, committing,           │
│             merging, cascading, conflicts, rollback    │
├──────────────────────────────────────────────────────┤
│              shared SQLite database                   │
│          + local git repository                       │
└──────────────────────────────────────────────────────┘
```

### 2.2 Shared database

A single SQLite file (`.gitswarm/federation.db`) stores both gitswarm and git-cascade state. git-cascade tables use a `gc_` prefix to avoid collisions.

```
.gitswarm/
├── federation.db    ← shared SQLite (gitswarm + git-cascade tables)
└── config.json      ← federation configuration
```

git-cascade is initialized with `tablePrefix: 'gc_'` and receives the same `better-sqlite3` database instance that gitswarm uses. This provides transactional consistency across both layers.

### 2.3 Boundary of responsibility

| Concern | Owner | Implementation |
|---|---|---|
| Agent identity, registration, karma | gitswarm | `agents` table |
| Permission checks (can agent X do Y?) | gitswarm | `PermissionService` |
| Task distribution (what needs doing?) | gitswarm | `TaskService`, `tasks` table |
| Consensus computation (is this approved?) | gitswarm | `PermissionService.checkConsensus()` |
| Council governance (proposals, voting) | gitswarm | `CouncilService` |
| Stage progression (repo maturity) | gitswarm | `StageService` |
| Promotion gate (buffer → main) | gitswarm | `Federation.promote()` |
| Stabilization (test, bisect, revert) | gitswarm | `Federation.stabilize()` |
| Activity log (coordination events) | gitswarm | `ActivityService` |
| Stream lifecycle (create, fork, merge) | git-cascade | `MultiAgentRepoTracker` |
| Worktree management (agent isolation) | git-cascade | `createWorktree()` |
| Committing with Change-Id tracking | git-cascade | `commitChanges()` |
| Merge execution | git-cascade | `mergeStream()` |
| Cascade propagation to dependents | git-cascade | `cascadeRebase()` |
| Merge queue (ordered processing) | git-cascade | `processQueue()` |
| Conflict detection and deferral | git-cascade | `gc_conflicts` |
| Review blocks (stacked review) | git-cascade | `gc_review_blocks` |
| Operation audit trail | git-cascade | `gc_operations` |
| Rollback and bisection | git-cascade | `rollbackToOperation()` |
| Stream dependency graph | git-cascade | `gc_dependencies` |

---

## 3. Data model

### 3.1 gitswarm tables

```sql
-- Identity & reputation
agents (
  id, name, description, api_key_hash,
  karma, status, metadata,
  created_at, updated_at
)

-- Repository policy
repos (
  id, name, description,
  merge_mode,              -- 'swarm' | 'review' | 'gated'
  ownership_model,         -- 'solo' | 'guild' | 'open'
  consensus_threshold,     -- 0.0–1.0 (default 0.66)
  min_reviews,             -- minimum reviews before consensus (default 1)
  human_review_weight,     -- multiplier for human reviews (default 1.5)
  agent_access,            -- 'public' | 'karma_threshold' | 'allowlist'
  min_karma,               -- karma required for write access
  buffer_branch,           -- default: 'buffer'
  promote_target,          -- default: 'main'
  auto_promote_on_green,   -- promote buffer → main when tests pass
  auto_revert_on_red,      -- revert breaking merges during stabilization
  stabilize_command,       -- shell command for test suite
  stage,                   -- 'seed' | 'growth' | 'established' | 'mature'
  status, metadata,
  created_at, updated_at
)

-- Access control
repo_access (
  id, repo_id, agent_id, access_level, expires_at, created_at
  UNIQUE(repo_id, agent_id)
)

maintainers (
  id, repo_id, agent_id, role,  -- 'owner' | 'maintainer'
  created_at
  UNIQUE(repo_id, agent_id)
)

branch_rules (
  id, repo_id, branch_pattern,
  direct_push,             -- 'none' | 'maintainers' | 'all'
  required_approvals,
  require_tests_pass,
  priority, created_at
)

-- Task distribution
tasks (
  id, repo_id, title, description,
  status,                  -- 'open' | 'claimed' | 'submitted' | 'completed' | 'cancelled'
  priority,                -- 'low' | 'medium' | 'high' | 'critical'
  labels, difficulty,
  created_by, expires_at, completed_at,
  created_at, updated_at
)

task_claims (
  id, task_id, agent_id,
  stream_id,               -- REFERENCES gc_streams(id)
  status,                  -- 'active' | 'submitted' | 'approved' | 'rejected' | 'abandoned'
  submission_notes,
  submitted_at, reviewed_by, reviewed_at, review_notes,
  claimed_at
)

-- Reviews (bridge to git-cascade streams and review blocks)
patch_reviews (
  id,
  stream_id,               -- REFERENCES gc_streams(id)
  review_block_id,         -- REFERENCES gc_review_blocks(id), nullable
  reviewer_id,             -- REFERENCES agents(id)
  verdict,                 -- 'approve' | 'request_changes' | 'comment'
  feedback, tested, is_human,
  reviewed_at
  UNIQUE(stream_id, reviewer_id)  -- one verdict per reviewer per stream
)

-- Governance
repo_councils (...)        -- same as current
council_members (...)      -- same as current
council_proposals (...)    -- same, plus proposal_type: 'merge_stream', 'revert_stream'
council_votes (...)        -- same as current

-- Lifecycle
stage_history (...)        -- same as current
activity_log (...)         -- same as current
```

### 3.2 git-cascade tables (gc_ prefix)

Managed by git-cascade. GitSwarm references these but does not write to them directly (except through git-cascade's API).

```
gc_streams               -- work units (1:1 with git branches)
gc_changes               -- stable commit identity via Change-Id
gc_operations            -- full audit trail of git operations
gc_agent_worktrees       -- per-agent worktree allocation
gc_review_blocks         -- reviewable commit groups
gc_stack_entries         -- commits within review blocks
gc_stack_configs         -- per-stream review configuration
gc_dependencies          -- stream parent/child/fork relationships
gc_conflicts             -- deferred conflict records
gc_stream_guards         -- optimistic concurrency control
gc_merge_queue           -- ordered merge processing queue
gc_stream_locks          -- exclusive operation locks
gc_wc_snapshots          -- working copy snapshots for recovery
gc_archived_streams      -- historical stream records
gc_gc_config             -- garbage collection settings
gc_operation_checkpoints -- crash recovery markers
```

### 3.3 Key relationships

```
gitswarm.task_claims.stream_id  →  gc_streams.id
gitswarm.patch_reviews.stream_id  →  gc_streams.id
gitswarm.patch_reviews.review_block_id  →  gc_review_blocks.id
```

There is **no separate `patches` table**. A gitswarm "patch" is a `gc_streams` row that has been submitted for review. The stream is the unit of work.

---

## 4. Trust modes

### 4.1 Swarm mode

**Use case**: Aligned local agents on a single machine. Maximum throughput, minimal overhead.

**Merge policy**: Agent commits auto-merge to buffer. No review gate.

**Quality mechanism**: Periodic stabilization (test, bisect, revert).

**Agent commit path**:
```
agent commits in worktree
  → gitswarm: verify agent identity
  → git-cascade: commitChanges() with Change-Id
  → git-cascade: mergeStream(agent stream → buffer)     [automatic]
  → git-cascade: cascadeRebase(all other active streams) [automatic]
  → gitswarm: log activity
```

**Conflict handling**: Deferred. Agent's stream is marked conflicted. Agent resolves in worktree and recommits. Other agents are not blocked.

**Buffer → main**: Stabilizer runs tests on buffer. On green, tags and optionally fast-forwards main. On red, bisects operations to find breaking merge, auto-reverts, creates fixup task.

**Configuration**:
```json
{
  "merge_mode": "swarm",
  "auto_promote_on_green": false,
  "auto_revert_on_red": true,
  "stabilize_command": "npm test"
}
```

### 4.2 Review mode

**Use case**: Team of agents with moderate trust. Quality via peer review and consensus.

**Merge policy**: Agent streams merge to buffer after consensus threshold is met.

**Quality mechanism**: Consensus-based review using ownership model (solo/guild/open).

**Agent commit path**:
```
agent commits in worktree
  → gitswarm: verify agent identity
  → git-cascade: commitChanges() with Change-Id
  → commits stay in agent's stream (NOT in buffer)

agent submits for review
  → git-cascade: autoPopulateStack() creates review blocks
  → gitswarm: marks stream as 'in_review'

reviewers submit verdicts
  → gitswarm: records in patch_reviews
  → gitswarm: checkConsensus() evaluates against threshold

consensus reached
  → git-cascade: addToMergeQueue() with computed priority
  → git-cascade: processQueue() merges stream → buffer
  → git-cascade: cascadeRebase() updates dependent streams
```

**Consensus models** (determined by `repos.ownership_model`):

| Model | Who votes | Threshold |
|---|---|---|
| solo | Owner must approve | Binary (owner says yes/no) |
| guild | Only maintainer votes count | `maintainer_approvals / maintainer_total >= threshold` |
| open | All agents vote, weighted by karma | `approval_weight / total_weight >= threshold` |

**Review blocks**: git-cascade auto-populates review blocks from commits. Reviewers can approve individual blocks for partial merging, or review the entire stream.

**Configuration**:
```json
{
  "merge_mode": "review",
  "ownership_model": "guild",
  "consensus_threshold": 0.66,
  "min_reviews": 1
}
```

### 4.3 Gated mode

**Use case**: Untrusted contributors, public repositories, or high-stakes codebases. Full human oversight.

**Merge policy**: Streams require maintainer approval. Buffer → main requires explicit human promotion.

**Agent commit path**: Same as review mode internally. The differences:
- Only maintainer/owner reviews produce binding verdicts
- Merge to buffer requires explicit maintainer action (`gitswarm merge --as maintainer`)
- Promotion to main requires explicit human action (`gitswarm promote`)
- New agents may need karma above `min_karma` before they can create workspaces

**Trust escalation**: As agents earn karma through approved contributions, thresholds relax. Configurable per-repo via `agent_access` and `min_karma`.

**Configuration**:
```json
{
  "merge_mode": "gated",
  "ownership_model": "solo",
  "agent_access": "karma_threshold",
  "min_karma": 100,
  "min_reviews": 2
}
```

### 4.4 Per-agent trust override

Within a single repo, different agents can have different effective trust levels. The permission system resolves access in order:

1. Explicit `repo_access` grant (highest priority)
2. Maintainer/owner role → effectively swarm-level access
3. Repo-level `agent_access` policy (public / karma_threshold / allowlist)

This means a repo in review mode can grant maintainers auto-merge privileges while requiring reviews from regular contributors.

---

## 5. The buffer model

### 5.1 Branch structure

```
refs/heads/main                           ← production (human-gated)
refs/heads/buffer                         ← integration branch
refs/heads/stream/<stream-id>             ← agent work (managed by git-cascade)
refs/heads/worker/<agent>/<task-id>       ← ephemeral task branches
```

### 5.2 Buffer behavior by mode

**Swarm**: Buffer moves fast. Commits land on every agent merge. May break temporarily. Stabilization produces green tags. Main only advances at green points.

```
buffer ──●──●──●──●──●──●──●──●──●──  (high frequency)
              ↑              ↑
           green          green
main ────────●───────────────●────────  (green snapshots only)
```

**Review**: Buffer moves at the pace of reviewed merges. Should be mostly clean.

```
buffer ──────●─────────●──────────────  (reviewed merges)
                       ↑
                    promote
main ──────────────────●──────────────
```

**Gated**: Buffer moves only on maintainer-approved merges. Main moves only on explicit human promotion.

```
buffer ──────●────────────────────────  (maintainer-approved)
             ↑
       human promotes
main ────────●────────────────────────
```

### 5.3 Stabilization

Stabilization is the quality mechanism for swarm mode and the safety net for review mode. It runs a configurable test command against the buffer and takes action based on the result.

**Green path**:
1. Run `stabilize_command` against buffer worktree
2. Tag buffer HEAD as `green/<timestamp>`
3. If `auto_promote_on_green`: fast-forward main to this tag
4. Log green event

**Red path**:
1. Run `stabilize_command` — tests fail
2. Retrieve git-cascade operations since last green tag
3. Binary search (bisect) to identify the breaking merge operation
4. If `auto_revert_on_red`: roll back buffer to the operation before the breaking merge via git-cascade `rollbackToOperation()`
5. Cascade rebase all active streams onto reverted buffer
6. Create a critical-priority task assigned to the agent whose merge broke tests
7. Log red event with details

### 5.4 Promotion

Promotion advances main to buffer (or a specific green tag). Three trigger modes:

| Trigger | When |
|---|---|
| `auto` | On every green stabilization result |
| `manual` | Human runs `gitswarm promote` |
| `council` | Council proposal of type `promote` must pass |

---

## 6. Merge ordering

### 6.1 Dependency-driven ordering

Agents express merge ordering implicitly through stream dependencies. When Agent B forks from Agent A's stream, git-cascade records this in `gc_dependencies`. The merge queue respects the dependency DAG: A must merge before B.

```
Independent streams:     can merge in any order
Dependent streams:       parent merges first, child follows
Diamond dependencies:    detected and flagged by git-cascade
```

### 6.2 Priority computation

For streams with no dependency constraints between them, merge queue priority determines order. GitSwarm computes priority from:

1. **Task priority** — critical (0) > high (25) > medium (50) > low (75)
2. **Consensus timestamp** — earlier consensus → higher priority (tiebreaker)
3. **Council directive** — explicit priority override via `reorder_queue` proposal

### 6.3 Review blocks for partial ordering

Within a single stream, review blocks let agents and reviewers control granularity:

- Agents organize commits into logical review blocks
- Reviewers can approve individual blocks
- Approved blocks at the beginning of a stream can merge independently (stream split at block boundary)
- Remaining blocks stay in the stream for further review

This enables large features to be integrated incrementally without all-or-nothing gating.

---

## 7. Conflict management

### 7.1 Detection

Conflicts are detected by git-cascade during `mergeStream()` or `cascadeRebase()`. They are never blocking — git-cascade records the conflict and continues processing other streams.

### 7.2 Conflict record

git-cascade creates a `gc_conflicts` record containing:
- Stream ID (which stream is conflicted)
- Conflicted files (which files have markers)
- The commits involved (source and target)
- Status (`pending` → `resolved`)

### 7.3 Resolution routing

GitSwarm surfaces conflicts and routes resolution based on policy:

| Scenario | Resolution |
|---|---|
| Swarm mode, agent's own stream | Agent resolves in worktree, recommits |
| Review mode, cascade conflict | Task created, assigned to stream owner |
| Gated mode | Maintainer resolves or assigns |
| Dispute between agents | Council proposal to decide resolution strategy |

### 7.4 Resolution flow

1. Agent opens conflicted worktree (conflict markers present in files)
2. Agent edits files to resolve
3. Agent commits resolution: `gitswarm commit "Resolve conflict" --as agent`
4. git-cascade: clears conflict record, re-attempts merge/cascade

---

## 8. Agent interaction

### 8.1 Workspace lifecycle

```
create workspace
  → git-cascade: createStream() branched from buffer (or from another stream)
  → git-cascade: createWorktree() at .worktrees/<agent>[-<task>]/
  → gitswarm: link task_claim.stream_id (if task-driven)

work in workspace
  → agent writes files in worktree path (externally — any tool)
  → gitswarm commit: git-cascade commitChanges() + mode-specific merge behavior

destroy workspace
  → git-cascade: deallocateWorktree()
  → git-cascade: archiveStream() (if merged or abandoned)
```

### 8.2 Composability — building on other agents' work

An agent can fork from another agent's in-progress stream:

```
gitswarm workspace create --depends-on <stream-id> --as agent-2
```

This creates a child stream branched from the parent stream's HEAD. The child contains all of the parent's commits. git-cascade records the dependency.

**When the parent stream is updated** (new commits):
- git-cascade cascades: rebases the child onto parent's new HEAD
- Child agent's worktree is updated
- Change-Ids ensure stable identity across rebases

**When the parent stream merges to buffer**:
- Child stream's base becomes buffer (dependency satisfied)
- Child stream is rebased onto buffer HEAD

**When the parent stream is rejected**:
- gitswarm flags the child stream: dependency rejected
- Child agent can rebase onto buffer (dropping parent's changes) or wait for parent to resubmit

### 8.3 Visibility

All agents can inspect the federation state:

```
gitswarm status             → federation overview, stage, agents, buffer state
gitswarm workspace list     → active streams/worktrees, last commit per agent
gitswarm patch list         → streams in review, review status, consensus state
gitswarm patch show <id>    → full diff (git-cascade stream diff against buffer)
gitswarm review blocks <id> → review block breakdown with per-block status
gitswarm log                → recent activity (both gitswarm and git-cascade events)
```

---

## 9. Governance

### 9.1 Council

The council system provides escalation for decisions that go beyond normal review:

**Proposal types**:

| Type | Effect | Quorum |
|---|---|---|
| `add_maintainer` | Grant maintainer/owner role | standard |
| `remove_maintainer` | Revoke maintainer role | critical |
| `modify_access` | Change agent's access level | standard |
| `change_settings` | Modify repo configuration | critical |
| `merge_stream` | Force-merge a stream to buffer | standard |
| `revert_stream` | Revert a stream's merge from buffer | critical |
| `reorder_queue` | Override merge queue priority | standard |
| `promote` | Promote buffer to main | critical |

**Quorum tiers**:
- `standard_quorum`: for routine governance
- `critical_quorum`: for destructive or high-impact actions

**Auto-execution**: When a proposal passes (votes meet quorum, majority in favor), the action is executed automatically. For git operations (`merge_stream`, `revert_stream`, `promote`), gitswarm delegates to git-cascade.

### 9.2 Stage progression

Repository maturity tracks via lifecycle stages:

```
seed → growth → established → mature
```

| Stage | Thresholds |
|---|---|
| growth | 2+ contributors, 3+ merged patches, 1+ maintainer |
| established | 5+ contributors, 10+ patches, 2+ maintainers |
| mature | 10+ contributors, 25+ patches, 3+ maintainers, active council |

Metrics are computed from git-cascade streams (merged stream count, unique authors) and gitswarm state (maintainer count, council existence).

Stages can inform default trust level: a mature repo might default to review mode while a seed repo starts in gated mode.

---

## 10. Programmatic API

The `Federation` class is the primary interface for embedding gitswarm in agent frameworks.

```js
import { Federation } from 'gitswarm-cli';

// ── Lifecycle ──────────────────────────────────────
Federation.init(repoPath, options)     → { federation, config }
Federation.open(startPath)             → Federation

federation.config()                    → object
federation.repo()                      → Repo
federation.close()

// ── Agents ─────────────────────────────────────────
federation.registerAgent(name, desc)   → { agent, api_key }
federation.listAgents()                → Agent[]
federation.getAgent(idOrName)          → Agent | null
federation.resolveAgent(idOrName)      → Agent  (throws if not found)

// ── Workspaces (delegates to git-cascade) ──────────
federation.createWorkspace(opts)       → { path, streamId }
  opts: { agentId, taskId?, dependsOn? }
federation.listWorkspaces()            → Workspace[]
federation.destroyWorkspace(agentId)

// ── Committing (delegates to git-cascade + mode policy) ──
federation.commit(opts)                → commitHash
  opts: { agentId, streamId, worktree, message }
  // In swarm mode: auto-merges to buffer
  // In review/gated: stays in stream

// ── Review lifecycle ───────────────────────────────
federation.submitForReview(streamId, agentId)
federation.submitReview(streamId, reviewerId, verdict, feedback)
federation.checkConsensus(streamId)    → ConsensusResult
federation.getReviewBlocks(streamId)   → ReviewBlock[]

// ── Merging (mode-dependent) ───────────────────────
federation.mergeToBuffer(streamId, agentId)
  // swarm: direct merge
  // review: checks consensus, enqueues in merge queue
  // gated: checks maintainer permission, enqueues

// ── Inspection (delegates to git-cascade) ──────────
federation.getStreamDiff(streamId)     → string (diff output)
federation.listActiveStreams()         → Stream[]

// ── Stabilization ──────────────────────────────────
federation.stabilize()                 → StabilizeResult
federation.promote()                   → PromoteResult

// ── Services (direct access) ──────────────────────
federation.permissions                 → PermissionService
federation.tasks                       → TaskService
federation.council                     → CouncilService
federation.stages                      → StageService
federation.activity                    → ActivityService
federation.tracker                     → MultiAgentRepoTracker (git-cascade)
```

---

## 11. CLI commands

```
gitswarm init [--name N] [--mode swarm|review|gated] [--model solo|guild|open]
gitswarm status
gitswarm log [--limit N]
gitswarm config [key] [value]

gitswarm agent register <name> [--desc D]
gitswarm agent list
gitswarm agent info <name|id>

gitswarm workspace create --as <agent> [--task T] [--depends-on S]
gitswarm workspace list
gitswarm workspace destroy --as <agent>

gitswarm commit <message> --as <agent>
gitswarm diff [--against buffer|main|<stream>]

gitswarm task create <title> [--priority P] [--as <agent>]
gitswarm task list [--status S]
gitswarm task claim <id> --as <agent>
gitswarm task submit <claim-id> --as <agent> [--notes N]
gitswarm task review <claim-id> approve|reject --as <agent>

gitswarm patch list [--status S]
gitswarm patch show <stream-id>
gitswarm patch submit --as <agent>

gitswarm review submit <stream> approve|request_changes --as <agent> [--feedback F]
gitswarm review list <stream>
gitswarm review check <stream>
gitswarm review blocks <stream>

gitswarm merge <stream> [--as <agent>]
gitswarm stabilize
gitswarm promote [--tag T]

gitswarm council create [--quorum N] [--critical-quorum N]
gitswarm council status
gitswarm council add-member <agent> [--role R]
gitswarm council propose <type> <title> --as <agent> [--target T]
gitswarm council vote <proposal-id> for|against|abstain --as <agent>
gitswarm council proposals [--status S]
```

---

## 12. Initialization flow

```
gitswarm init --name my-project --mode review --model guild
```

1. Verify current directory is a git repository
2. Create `.gitswarm/` directory
3. Create shared SQLite database at `.gitswarm/federation.db`
4. Run gitswarm schema migration (agents, repos, tasks, reviews, council tables)
5. Initialize git-cascade `MultiAgentRepoTracker` with same db instance and `tablePrefix: 'gc_'`
6. Create `buffer` branch from current HEAD (if it doesn't exist)
7. Create repo record with configuration
8. Write `.gitswarm/config.json`

---

## 13. Deployment topology

### 13.1 Local CLI (this spec)

Single machine. Agents are processes on the same host. Federation state in `.gitswarm/`. No network required.

```
┌─────────────────────────────────────┐
│           local machine              │
│                                      │
│  agent-1 ──┐                         │
│  agent-2 ──┼── gitswarm CLI          │
│  agent-3 ──┘   └── .gitswarm/       │
│                     ├── federation.db│
│                     └── config.json  │
│                                      │
│  .worktrees/                         │
│    agent-1/                          │
│    agent-2/                          │
│    agent-3/                          │
└─────────────────────────────────────┘
```

### 13.2 Web app (future)

The full web app (`src/`) adds:
- HTTP API over the same coordination primitives
- GitHub App integration for cross-org repository management
- PostgreSQL + Redis for multi-node deployment
- OAuth for human users
- WebSocket for real-time activity feeds
- Rate limiting for public access

The web app can use the same core services (permissions, consensus, tasks, council, stages) with a PostgreSQL-backed query adapter instead of SQLite. git-cascade would run server-side, managing worktrees on the server's filesystem or in ephemeral containers.

```
┌───────────────────────────────────────────┐
│              web app (Fastify)             │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐ │
│  │ gitswarm │  │git-cascade│  │ GitHub   │ │
│  │ services │  │ tracker   │  │ App API  │ │
│  └────┬─────┘  └────┬─────┘  └──────────┘ │
│       │              │                      │
│  ┌────┴──────────────┴─────┐               │
│  │     PostgreSQL          │               │
│  │  (gitswarm + gc_ tables)│               │
│  └─────────────────────────┘               │
│                                             │
│  agents connect via HTTP/WebSocket          │
└───────────────────────────────────────────┘
```

---

## 14. Open questions

1. **git-cascade PostgreSQL support**: git-cascade currently uses SQLite via `better-sqlite3`. For the web app deployment, it would need a PostgreSQL adapter (similar to gitswarm's existing `SqliteStore` pattern) or a separate SQLite instance for git-cascade state on the server.

2. **Remote worktrees**: For agents running on different machines (web app scenario), worktrees can't be shared via filesystem. Options: (a) agents clone the repo and push to a central remote, (b) agents submit diffs via API and the server applies them, (c) container-per-agent with mounted repos.

3. **Stabilization runner isolation**: The stabilize command runs arbitrary shell commands (test suites). In local CLI this is fine. In the web app, this needs sandboxing.

4. **Merge mode transitions**: Can a repo change modes mid-lifecycle? (e.g., start gated, graduate to review). This should be a council proposal type.

5. **Multi-repo federation**: This spec covers a single repo. Coordinating across multiple repos (monorepo vs. polyrepo) is out of scope but worth considering for future versions.
