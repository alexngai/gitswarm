# GitSwarm Agent-First Git Platform

**Version**: 0.1.0
**Date**: 2026-04-04
**Status**: Draft
**Scope**: Design for replacing GitHub with a self-hosted, agent-first git platform using GitSwarm + Gitea

---

## 1. Motivation

GitSwarm already handles the hard coordination work — consensus, council voting, karma,
merge locking, staging buffers, and stream management. GitHub currently serves as:

1. **Git remote hosting** (bare repos over HTTPS/SSH)
2. **PR UI** for human review
3. **Webhooks** for event notifications
4. **Auth** (tokens, SSH keys)
5. **CI triggers** (Actions)

None of these are inherently tied to GitHub. Agents don't need a diff viewer or PR UI —
GitSwarm's governance primitives *are* the review process. By self-hosting the git layer,
we eliminate rate limits, API quotas, and the impedance mismatch of forcing agent-native
workflows through human-centric GitHub APIs.

### What We Gain

- **No rate limits or API quotas** — agents interact at full speed
- **Custom merge semantics** — buffer branches, staged promotion, auto-rebase are native
- **Git-level enforcement** — governance rules in pre-receive hooks, not application-layer checks
- **Simpler stack** — no GitHub App, no OAuth dance, no webhook signature verification
- **Full control over the review model** — agents reviewing agents doesn't need a PR UI
- **Real-time event streaming** — native pub/sub replaces webhook polling

### What We Lose (and Mitigations)

| Lost | Mitigation |
|------|------------|
| Human-friendly PR UI | Gitea web UI + GitSwarm dashboard (React, already planned) |
| GitHub Actions CI | Gitea act_runner (Actions-compatible) or direct test execution in server worktrees |
| Discoverability / social | Not relevant for agent-first use |
| GitHub ecosystem (Dependabot, Renovate, etc.) | Gitea has native support for most tools; build the rest as plugins |
| GitHub App marketplace | GitSwarm plugin system replaces this |

---

## 2. Architecture Overview

Three layers, cleanly separated:

```
┌─────────────────────────────────────────────────────────┐
│                  GitSwarm Platform                        │
│                                                           │
│  Layer 3: Agent Coordination (existing)                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Streams, Council, Consensus, Karma, Tasks,          │  │
│  │ Plugins, Merge Locks, Stabilization, Promotion      │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                 │
│  Layer 2: GitHub-Compatible API (new facade)              │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │ /repos, /pulls, /issues, /git, /webhooks            │  │
│  │ Translates GitHub REST API → GitSwarm operations     │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                 │
│  Layer 1: Git Hosting (Gitea, swappable)                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │ Bare repos, SSH/HTTP git protocol, worktrees         │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌─────────────┐     HTTP/WS API      ┌──────────────────────────────────┐
│  Agent 1    │◄────────────────────►│        GitSwarm Server            │
│  Agent 2    │                      │                                   │
│  Agent N    │                      │  ┌─────────────────────────────┐  │
│             │                      │  │ Governance Engine            │  │
└─────────────┘                      │  │ (council, karma, consensus) │  │
                                     │  └────────────┬────────────────┘  │
┌─────────────┐     SSH/HTTP         │  ┌────────────▼────────────────┐  │
│ Human (opt) │◄───────────────────►│  │ Gitea (embedded/sidecar)    │  │
│ via web UI  │                      │  │ - bare repo hosting          │  │
└─────────────┘                      │  │ - SSH/HTTP git protocol      │  │
                                     │  │ - GitHub-compatible API      │  │
                                     │  │ - act_runner for CI          │  │
                                     │  └────────────┬────────────────┘  │
                                     │  ┌────────────▼────────────────┐  │
                                     │  │ Event Bus (Redis pub/sub)   │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌────────────────────────────┐  │
                                     │  │ PostgreSQL (state + govern) │  │
                                     │  └────────────────────────────┘  │
                                     └──────────────────────────────────┘
```

---

## 3. Why Gitea (Not GitLab, Not From Scratch)

### The Decision

Use **Gitea/Forgejo** as the git hosting layer underneath GitSwarm.

### Comparison

| Factor | GitLab CE | Gitea/Forgejo | From Scratch |
|--------|-----------|---------------|--------------|
| RAM per instance | 4-8 GB | 128-256 MB | Minimal |
| Binary size | ~1GB+ (Rails + deps) | ~40 MB | Custom |
| Startup time | 30-60s | <1s | Custom |
| GitHub API compat | Own API | Yes (`/api/v1/`) | Must build |
| Embeddability | Impossible | Feasible (Go) | N/A |
| Per-tenant cost | Expensive | Cheap | Cheap |
| Operational complexity | High | Low | Highest |
| Git storage at scale | Gitaly (excellent) | Basic (adequate) | Must build |
| CI support | Built-in | act_runner (Actions-compat) | Must build |
| Ecosystem tools | GitLab-specific | GitHub-compatible | None |

### Rationale

- **GitLab** is a monolithic Rails app designed for human teams. 4GB+ RAM per tenant makes
  multi-tenant hosting impractical. Its API is not GitHub-compatible.
- **From scratch** means building git hosting, auth, web UI, and CI — commoditized problems
  already solved by Gitea.
- **Gitea** is a single 40MB Go binary. It implements GitHub's REST API surface, sends
  identical webhook payloads, and supports Actions-compatible CI. Most GitHub ecosystem
  tools (Renovate, drone, IDE integrations) work with Gitea out of the box.

### The One Thing GitLab Does Better: Gitaly

At serious scale (thousands of repos, terabytes of data), Gitea's git storage is naive —
bare repos on disk. GitLab's Gitaly handles repo sharding, gRPC-based git ops, and
replication. But:

- Gitaly is open source (Apache 2.0) — usable standalone without GitLab
- We don't need it until GitLab.com-scale
- A simpler sharding scheme (repos partitioned by tenant ID) works for Phase 1-2

**Decision**: Start with Gitea. Swap the storage layer later if scale demands it.

---

## 4. GitHub Ecosystem Compatibility

### Gitea's GitHub API Surface

| GitHub Feature | Gitea Support |
|----------------|---------------|
| Repos, branches, tags | Yes |
| Pull requests + reviews | Yes |
| Webhooks (same payload format) | Yes |
| OAuth2 / token auth | Yes |
| Actions-compatible CI | Yes (act_runner) |
| Container registry | Yes |
| Packages | Yes |
| GitHub App manifests | No (token auth works) |

### Ecosystem Tools That Work with Gitea

- **Renovate** (dependency updates) — native Gitea support
- **act / act_runner** (GitHub Actions locally) — Gitea's CI is built on this
- **drone CI** — first-class Gitea integration
- **IDE git integration** — any IDE that speaks git protocol works automatically
- **Terraform gitea provider** — IaC for repo management
- **pre-commit** — webhook-triggered alternatives available

### GitHub-Compatible API Facade (Layer 2)

For tools that *only* speak GitHub API, GitSwarm exposes a `/api/v3/` facade that
translates GitHub REST calls into GitSwarm operations:

```
/api/v3/repos/:owner/:repo                    → gitswarm_repos
/api/v3/repos/:owner/:repo/pulls              → gitswarm_streams (!)
/api/v3/repos/:owner/:repo/pulls/:id/reviews  → gitswarm_stream_reviews
/api/v3/repos/:owner/:repo/issues             → gitswarm_tasks
/api/v3/repos/:owner/:repo/git/refs           → Gitea passthrough
/api/v3/repos/:owner/:repo/branches           → Gitea passthrough
/api/v3/repos/:owner/:repo/contents/:path     → Gitea passthrough
/api/v3/repos/:owner/:repo/hooks              → webhook management
/api/v3/user                                  → agents (current auth)
```

**Key translation: Pull Requests = Streams**

When an external tool creates a "PR", it creates a GitSwarm stream with governance.
When it "approves" a PR, it submits a council/stream review. When it "merges", GitSwarm
checks consensus first — governance is enforced transparently.

| GitHub API Endpoint | GitSwarm Handler |
|---------------------|------------------|
| Git operations (refs, trees, blobs, commits) | Passthrough to Gitea |
| File contents, branches, tags | Passthrough to Gitea |
| Repository CRUD | GitSwarm (creates in both Gitea + DB) |
| Pull requests | GitSwarm streams (governance layer) |
| PR reviews | GitSwarm reviews (consensus) |
| PR merge | GitSwarm merge (governance-gated) |
| Issues | GitSwarm tasks |
| Webhooks config | GitSwarm (manages both internal + Gitea hooks) |
| Users / auth | GitSwarm agents |
| Actions / CI | GitSwarm plugins or act_runner |

---

## 5. Current Codebase: What Exists and What Changes

### Existing Git Backend Abstraction

GitSwarm already has a `GitBackend` abstract class (`src/services/git-backend.ts`) with
two implementations:

- **`GitHubBackend`** (`src/services/github-backend.ts`) — delegates to GitHub REST API
- **`CascadeBackend`** (`src/services/cascade-backend.ts`) — server-side git-cascade (Mode C)

Selection is per-repo via the `git_backend` column in `gitswarm_repos`. The
`BackendFactory` (`src/services/backend-factory.ts`) instantiates the correct backend.

**This abstraction is the key enabler.** Adding a `GiteaBackend` is a third implementation
of the same interface — no changes to routes, governance, or plugins.

### GitBackend Interface (current)

```typescript
class GitBackend {
  async readFile(repoId, path, ref?): Promise<FileResult>
  async listDirectory(repoId, path, ref?): Promise<DirectoryEntry[]>
  async getTree(repoId, ref?): Promise<TreeResult>
  async getCommits(repoId, options?): Promise<CommitResult[]>
  async getBranches(repoId): Promise<BranchResult[]>
  async writeFile(repoId, path, content, message, branch, author?): Promise<WriteResult>
  async createBranch(repoId, name, fromRef): Promise<object>
  async createPullRequest(repoId, prData): Promise<object>
  async mergePullRequest(repoId, prNumberOrStreamId, options?): Promise<object>
  async getCloneAccess(repoId): Promise<CloneAccessResult>
}
```

### Database Schema Changes

Current tables reference GitHub directly. These need to become backend-agnostic:

**`gitswarm_orgs`** — currently has:
- `github_org_name`, `github_org_id`, `github_installation_id`

**`gitswarm_repos`** — currently has:
- `github_repo_name`, `github_repo_id`, `github_full_name`
- `git_backend` (already supports `'github'` | `'cascade'`)

**Required migrations:**

```sql
-- Add Gitea as a backend option and generic fields
ALTER TABLE gitswarm_repos
  ADD COLUMN git_backend_url TEXT,           -- Gitea instance URL
  ADD COLUMN external_repo_id TEXT;          -- Gitea repo ID (or GitHub)

-- Update git_backend to support 'gitea'
-- (already VARCHAR, just needs new valid value)

-- Add backend-agnostic org fields
ALTER TABLE gitswarm_orgs
  ADD COLUMN git_backend TEXT DEFAULT 'github',
  ADD COLUMN backend_url TEXT,
  ADD COLUMN backend_org_id TEXT;
```

The existing `github_*` columns remain for backward compatibility with repos already
on GitHub. New Gitea repos use the generic columns.

### Webhook Handler (`src/routes/webhooks.ts`)

The 44KB webhook handler currently processes GitHub events. Key changes:

1. **Add Gitea route**: `POST /webhooks/gitea` alongside existing `POST /webhooks/github`
2. **Shared handler logic**: Gitea sends the same payload format with the same event names
   (`pull_request`, `push`, `pull_request_review`). The handler logic is ~95% reusable.
3. **Header discrimination**: `X-Gitea-Event` vs `X-GitHub-Event`
4. **Signature verification**: Gitea uses HMAC-SHA256 — same algorithm, just different header

### Config Changes (`src/config/env.ts`)

```typescript
// New environment variables
GITEA_URL: string;           // e.g., http://localhost:3001
GITEA_ADMIN_TOKEN: string;   // Gitea API token for admin operations
GITEA_SSH_PORT: number;      // e.g., 2222
```

GitHub config (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, etc.) becomes optional — only
needed if GitHub backend is in use.

### Plugin Engine (`src/services/plugin-engine.ts`)

The plugin engine is already event-driven and backend-agnostic:
- Receives events as `{ event, action, payload }`
- Matches against `trigger_event` field on plugins
- Dispatches via `execution_model` (builtin, dispatch, workflow, webhook)

**No changes needed** — Gitea webhooks produce the same event shape. The `dispatch`
execution model (GitHub Actions) would need a Gitea equivalent (act_runner dispatch),
but `builtin` and `webhook` models work as-is.

---

## 6. Gitea Integration Design

### Deployment Topology

Gitea runs as a **sidecar** alongside the GitSwarm server:

```yaml
# docker-compose.yml additions
services:
  gitea:
    image: gitea/gitea:latest
    ports:
      - "3001:3000"    # Gitea web/API
      - "2222:22"      # Gitea SSH
    volumes:
      - gitea-data:/data
      - ./hooks:/data/gitea/hooks  # Custom server-side hooks
    environment:
      - GITEA__server__ROOT_URL=http://localhost:3001
      - GITEA__server__SSH_PORT=2222
      - GITEA__webhook__ALLOWED_HOST_LIST=api  # Allow webhooks to GitSwarm
      - GITEA__service__DISABLE_REGISTRATION=true  # GitSwarm manages users
      - GITEA__api__ENABLE_SWAGGER=false
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/v1/version"]
      interval: 10s
      retries: 5
```

**Why sidecar, not embedded**: Simpler ops, independent upgrades, clear failure boundary.
Can revisit embedding Gitea's Go libraries later if the process boundary becomes a
bottleneck.

### GiteaBackend Implementation

```typescript
// src/services/gitea-backend.ts
import { GitBackend } from './git-backend.js';

export class GiteaBackend extends GitBackend {
  private baseUrl: string;   // GITEA_URL
  private token: string;     // GITEA_ADMIN_TOKEN

  async readFile(repoId, path, ref?) {
    // GET /api/v1/repos/{owner}/{repo}/contents/{path}?ref={ref}
    // Response format is identical to GitHub's contents API
  }

  async createPullRequest(repoId, prData) {
    // POST /api/v1/repos/{owner}/{repo}/pulls
    // Maps to Gitea PR, but GitSwarm also creates a stream
  }

  async mergePullRequest(repoId, prNumber, options?) {
    // POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge
    // Only called AFTER GitSwarm governance check passes
  }

  async getCloneAccess(repoId) {
    // Returns Gitea clone URL with token auth
    // SSH: ssh://git@host:2222/{owner}/{repo}.git
    // HTTP: http://host:3001/{owner}/{repo}.git
  }
}
```

### Webhook Wiring

```
Gitea repo webhook → POST http://api:3000/webhooks/gitea
  → Parse event (push, pull_request, pull_request_review)
  → Update stream/review/merge state in PostgreSQL
  → Trigger plugin engine
  → Broadcast via WebSocket to connected agents
```

Gitea webhooks are configured automatically when a repo is created via GitSwarm API.
The webhook secret is generated per-repo and stored in `gitswarm_repos.webhook_secret`.

### Repo Lifecycle

When an agent creates a repo via GitSwarm:

1. **GitSwarm** creates `gitswarm_repos` row with `git_backend = 'gitea'`
2. **GitSwarm** calls Gitea API to create the repo (`POST /api/v1/orgs/{org}/repos`)
3. **GitSwarm** installs webhook on the Gitea repo pointing back to itself
4. **GitSwarm** installs server-side pre-receive hook (see Section 7)
5. **GitSwarm** creates default branch rules based on repo stage

Agents interact purely via GitSwarm API — they never touch Gitea directly.

### Agent Identity

No GitHub accounts needed. Agents authenticate with GitSwarm tokens/API keys.
For git push/pull operations over SSH or HTTP, GitSwarm provisions Gitea
credentials mapped to agent IDs:

```
Agent ID (GitSwarm) ←→ Gitea user (auto-provisioned)
                    ←→ SSH key or access token
                    ←→ Karma, roles, permissions (GitSwarm-native)
```

---

## 7. Git Protocol-Level Governance

### Pre-Receive Hook

Server-side hooks installed in Gitea's bare repos enforce governance at the
git protocol level — an agent literally cannot push to a protected branch
without consensus, even if it bypasses the API.

```bash
#!/bin/bash
# hooks/pre-receive — installed in each Gitea repo
# Called before git accepts a push

GITSWARM_API="http://api:3000/api/v1/internal"

while read oldrev newrev refname; do
  RESULT=$(curl -sf "$GITSWARM_API/git/pre-receive" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Secret: $GITSWARM_HOOK_SECRET" \
    -d "{
      \"ref\": \"$refname\",
      \"old_sha\": \"$oldrev\",
      \"new_sha\": \"$newrev\",
      \"pusher\": \"$GITEA_PUSHER_NAME\",
      \"repo_path\": \"$GIT_DIR\"
    }")

  ALLOWED=$(echo "$RESULT" | jq -r '.allowed')
  if [ "$ALLOWED" != "true" ]; then
    REASON=$(echo "$RESULT" | jq -r '.reason')
    echo "GitSwarm: push denied — $REASON" >&2
    exit 1
  fi
done
```

### Pre-Receive API Endpoint

```
POST /api/v1/internal/git/pre-receive
```

Internal-only endpoint (authenticated via shared secret, not agent tokens).
Evaluates governance rules:

| Push Target | Rule |
|-------------|------|
| `main` / `master` | Denied always — merges only via promotion |
| `buffer` | Allowed only if stream has consensus + merge lock acquired |
| `stream/*` | Allowed if pusher is stream owner or has write access |
| Feature branches | Allowed based on branch rules + agent permissions |

### Post-Receive Hook

Fires after a push is accepted. Triggers:

1. **Stream detection** — if push is to a `stream/*` branch, update stream state
2. **Plugin dispatch** — fire `push` event through plugin engine
3. **Stabilization trigger** — if push is to `buffer`, queue stabilization tests
4. **Event broadcast** — notify connected agents via WebSocket

---

## 8. Event System

### Current State

GitSwarm currently relies on GitHub webhooks (poll-based from GitHub's perspective,
push to GitSwarm). The WebSocket server (`src/services/websocket.ts`) broadcasts
activity events to connected clients.

### Target State: Native Event Bus

Replace webhook polling with a real-time event system using Redis pub/sub
(already in the stack):

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│ Git hooks    │────►│  Redis pub/sub  │────►│  Agent WS    │
│ Gitea webhooks│    │                 │     │  connections │
│ API mutations │    │  Channels:      │     └──────────────┘
│ Plugin results│    │  repo:{id}      │
│ Consensus    │    │  agent:{id}     │     ┌──────────────┐
│  changes     │    │  stream:{id}    │────►│  Plugin      │
└──────────────┘    │  global         │     │  engine      │
                    └─────────────────┘     └──────────────┘
```

### Event Types

```typescript
interface GitSwarmEvent {
  type: string;
  repo_id: string;
  timestamp: string;
  actor: { agent_id: string; name: string };
  payload: Record<string, any>;
}

// Git events
type: 'push'                    // Branch updated
type: 'branch.created'          // New branch
type: 'branch.deleted'          // Branch removed

// Stream events
type: 'stream.created'          // New work stream
type: 'stream.updated'          // Stream status change
type: 'stream.review.submitted' // Review added
type: 'stream.consensus.reached'// Consensus threshold met
type: 'stream.merged'           // Stream merged to buffer
type: 'stream.rejected'         // Stream rejected

// Governance events
type: 'council.proposal.created'
type: 'council.proposal.voted'
type: 'council.proposal.resolved'
type: 'council.election.started'

// Stabilization events
type: 'stabilization.started'   // Tests running on buffer
type: 'stabilization.passed'    // Buffer is green
type: 'stabilization.failed'    // Buffer broke, revert needed

// Promotion events
type: 'promotion.started'       // Buffer → main
type: 'promotion.completed'

// Task events
type: 'task.created'
type: 'task.claimed'
type: 'task.completed'
```

### Agent Subscription API

```
WebSocket: ws://host:3000/ws/events

// Subscribe to repo events
{ "action": "subscribe", "channel": "repo:{id}" }

// Subscribe to own agent events
{ "action": "subscribe", "channel": "agent:{id}" }

// Subscribe to specific stream
{ "action": "subscribe", "channel": "stream:{id}" }
```

Agents receive events in real-time instead of polling. This is a fundamental
improvement over GitHub webhooks — sub-second latency, no rate limits, no
missed events.

---

## 9. Scaling: From Self-Hosted to Cloud

### Phase 1: Self-Hosted (Single Team)

One Gitea instance + one GitSwarm server per team/org:

```
┌────────────────────────────────────────┐
│  Single VPS / Docker Compose            │
│                                         │
│  GitSwarm API  ←→  Gitea (sidecar)     │
│       ↕                ↕                │
│  PostgreSQL        Git repos on disk    │
│  Redis             SSH/HTTP access      │
│                                         │
│  Agents: 5-50 per org                   │
│  Repos: 1-100                           │
│  RAM: 512MB-2GB total                   │
└────────────────────────────────────────┘
```

**This is the v1 target.** Ship as Docker Compose or single deployable unit.
Users self-host on any VPS. Validates the product before investing in multi-tenancy.

### Phase 2: Hosted Multi-Tenant (Gitea-per-Tenant)

When demand justifies a hosted offering:

```
┌─────────────────────────────────────────────────────┐
│                   GitSwarm Cloud                      │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Tenant A │  │ Tenant B │  │ Tenant C │  ...      │
│  │          │  │          │  │          │           │
│  │ GitSwarm │  │ GitSwarm │  │ GitSwarm │           │
│  │ + Gitea  │  │ + Gitea  │  │ + Gitea  │           │
│  │ instance │  │ instance │  │ instance │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │             │             │                  │
│  ┌────▼─────────────▼─────────────▼──────┐           │
│  │      Shared Infrastructure             │           │
│  │  API gateway, auth, billing, metrics   │           │
│  └───────────────────────────────────────┘           │
└─────────────────────────────────────────────────────┘
```

Each tenant gets an isolated Gitea + GitSwarm instance on k8s or Fly.io.

**Why per-tenant isolation (not shared platform)**:
- Strong security isolation by default — agent code never leaks across tenants
- Simple ops — each instance is identical, just add more
- Tenants can self-host the same setup if they want to leave
- No need to solve row-level security, repo sharding, or object storage early

### Phase 3: Shared Platform (at scale)

Only if per-tenant overhead becomes prohibitive:

- Single GitSwarm API layer with row-level security
- Git repos in object storage (Gitaly-style) with per-tenant encryption
- Worktree operations in ephemeral containers (Firecracker / gVisor)
- Partitioned Redis streams or NATS per tenant

### Scaling Bottlenecks and Mitigations

| Bottleneck | Why It's Hard | Mitigation |
|------------|---------------|------------|
| Git worktrees at scale | Each stream = worktree = disk I/O + inodes | Object storage, ephemeral worktrees, shallow clones |
| Merge/rebase compute | Server-side merges are CPU-bound | Queue-based processing, dedicated merge workers |
| Test execution | Stabilization tests = arbitrary code | Sandboxed containers (Firecracker, gVisor), resource limits |
| Event fanout | N agents × M repos × K events | Partitioned Redis streams or NATS per tenant |
| Git storage growth | Repos grow unboundedly | Git object dedup, pack files, prune policies |

### Tenant-Aware Data Model

Design for multi-tenancy from day one, even in single-tenant mode:

```sql
-- All tables already namespace by repo_id/org_id
-- Add explicit tenant_id for future cloud use

ALTER TABLE gitswarm_orgs ADD COLUMN tenant_id UUID;
ALTER TABLE gitswarm_repos ADD COLUMN tenant_id UUID;

-- In single-tenant mode, tenant_id is NULL (or a single default value)
-- In cloud mode, row-level security enforces isolation
```

This is cheap to add now and extremely painful to retrofit.

### Pricing Model (Cloud)

Traditional per-seat pricing doesn't work for agent swarms:

- **Per-agent-hour** — how long agents are actively coordinating
- **Per-merge** — pay for governance decisions, not storage
- **Per-repo + compute tier** — base fee + worktree/CI minutes
- **Free tier** — 1 repo, 5 agents, 100 merges/month

---

## 10. Agent-First API Extensions

Beyond GitHub compatibility, GitSwarm exposes endpoints that GitHub doesn't have —
the agent-native capabilities that are the product's differentiator.

### Governance API

```
GET    /api/v1/streams/:id/consensus       → Real-time consensus state
POST   /api/v1/streams/:id/reviews         → Submit review with verdict + karma weight
GET    /api/v1/streams/:id/council         → Council voting status
POST   /api/v1/streams/:id/merge           → Governance-gated merge (consensus required)
```

### Agent Identity & Reputation

```
GET    /api/v1/agents/:id                  → Agent profile + karma
GET    /api/v1/agents/:id/karma            → Karma breakdown by repo
GET    /api/v1/agents/:id/streams          → Agent's active streams
POST   /api/v1/agents/:id/keys            → Register SSH key for git access
```

### Buffer & Promotion

```
POST   /api/v1/repos/:id/stabilize        → Trigger buffer stabilization tests
GET    /api/v1/repos/:id/stabilize/status  → Current stabilization status
POST   /api/v1/repos/:id/promote          → Promote buffer → main (after green)
GET    /api/v1/repos/:id/promotion/history → Promotion audit trail
```

### Coordination

```
POST   /api/v1/repos/:id/swarm            → Coordinate multiple agents on a task
GET    /api/v1/repos/:id/merge-queue      → Current merge queue state
POST   /api/v1/repos/:id/merge-lock       → Acquire/release merge lock
```

### Real-Time Events

```
WS     /ws/events                          → WebSocket event stream
POST   /api/v1/events/subscribe           → Subscribe to channels (REST fallback)
```

Tools that understand GitSwarm use these richer APIs. Tools that only speak
GitHub use `/api/v3/` and get the translated experience.

---

## 11. Implementation Roadmap

### Step 1: GiteaBackend Implementation
**Effort**: Small | **Impact**: Unblocks everything

- Create `src/services/gitea-backend.ts` implementing `GitBackend`
- Register `'gitea'` as valid value for `git_backend` in `BackendFactory`
- Add `GITEA_URL` and `GITEA_ADMIN_TOKEN` to `src/config/env.ts`
- Gitea's API mirrors GitHub's, so most methods are near-identical to `GitHubBackend`

### Step 2: Gitea Docker Sidecar
**Effort**: Tiny | **Impact**: Get it running

- Add Gitea service to `docker-compose.yml`
- Configure networking so GitSwarm API can reach Gitea on internal network
- Verify Gitea starts and serves git over HTTP/SSH

### Step 3: Webhook Wiring
**Effort**: Medium | **Impact**: Replace GitHub dependency for event flow

- Add `POST /webhooks/gitea` route
- Implement `X-Gitea-Event` header parsing + HMAC-SHA256 signature verification
- Reuse existing webhook handler logic (~95% shared with GitHub handler)
- Auto-configure Gitea webhooks when repos are created

### Step 4: Database Schema Generalization
**Effort**: Small | **Impact**: Clean foundation

- Add `git_backend_url`, `external_repo_id` columns to `gitswarm_repos`
- Add `git_backend`, `backend_url`, `backend_org_id` to `gitswarm_orgs`
- Keep existing `github_*` columns for backward compatibility
- Add migration to support `'gitea'` in `git_backend` column

### Step 5: Repo Lifecycle Management
**Effort**: Medium | **Impact**: End-to-end Gitea repo creation

- Implement Gitea repo creation via API when `git_backend = 'gitea'`
- Auto-provision Gitea users mapped to GitSwarm agent IDs
- Install webhooks and server-side hooks on new repos
- Configure default branch protection rules

### Step 6: Pre-Receive Hook Integration
**Effort**: Medium | **Impact**: Git-level governance enforcement

- Create pre-receive hook script
- Implement `POST /api/v1/internal/git/pre-receive` endpoint
- Evaluate branch rules, consensus state, merge locks in the hook
- Install hooks in Gitea repo directories automatically

### Step 7: GitHub-Compatible API Facade (`/api/v3/`)
**Effort**: Large | **Impact**: GitHub ecosystem compatibility

- Build incrementally — start with repos + pulls endpoints
- Implement PR → Stream translation layer
- Add review → consensus mapping
- Merge endpoint checks governance before allowing
- Add endpoints as external tools need them

### Step 8: Event System Enhancement
**Effort**: Medium | **Impact**: Real-time agent coordination

- Formalize event types and channel structure
- Implement Redis pub/sub channels per repo/stream/agent
- Enhance WebSocket server to support channel subscriptions
- Emit events from all mutation points (hooks, API, plugins)

### Step 9: Agent-First Extensions
**Effort**: Ongoing | **Impact**: Product differentiation

- Consensus API, karma API, stabilization API
- Merge queue management
- Cross-repo agent coordination
- Real-time dashboards

### Step 10: Cloud Readiness (when needed)
**Effort**: Large | **Impact**: Hosted offering

- Add `tenant_id` to data model
- Containerize GitSwarm + Gitea as deployable unit
- Build provisioning API for tenant onboarding
- Add billing hooks

### Priority Matrix

| Step | Dependencies | Sprint Estimate |
|------|-------------|-----------------|
| 1. GiteaBackend | None | 1-2 days |
| 2. Docker sidecar | None | Hours |
| 3. Webhook wiring | 1, 2 | 2-3 days |
| 4. DB generalization | None | 1 day |
| 5. Repo lifecycle | 1, 2, 4 | 3-4 days |
| 6. Pre-receive hooks | 2, 5 | 2-3 days |
| 7. API facade | 1, 5 | 1-2 weeks (incremental) |
| 8. Event system | 3 | 3-4 days |
| 9. Agent extensions | 5, 8 | Ongoing |
| 10. Cloud readiness | All above | 2-4 weeks |

**Steps 1-4 are a focused sprint.** Step 7 is the bulk of the work but can be
built incrementally. Steps 1-6 give you a fully functional self-hosted platform
without GitHub dependency.

---

## 12. Open Questions

### Architecture Decisions Pending

1. **Gitea sidecar vs embedded?** Starting with sidecar (separate process). Revisit
   embedding Go libraries if the HTTP hop becomes a latency bottleneck for high-frequency
   git operations.

2. **Gitea database: shared PostgreSQL or separate SQLite?** Gitea can use the same
   PostgreSQL instance. Simpler for single-tenant, but adds coupling. Separate SQLite
   is simpler to reason about but means two data stores.

3. **Agent SSH key management**: Auto-provision per agent, or use HTTP token auth
   exclusively? SSH is faster for large repos but adds key management complexity.

4. **GitHub migration path**: For existing GitSwarm repos on GitHub, provide a migration
   tool? Gitea can mirror/import GitHub repos natively.

5. **act_runner deployment**: Run alongside Gitea, or as a separate scalable pool?
   Stabilization tests via act_runner vs direct execution in server worktrees.

6. **API facade scope**: Which GitHub API endpoints to implement first? Prioritize
   by which ecosystem tools users actually want (Renovate, IDE plugins, etc.).

### Product Questions

7. **Is GitHub backend still supported long-term?** Or does Gitea fully replace it?
   Recommendation: keep both — some teams will want GitHub as their remote.

8. **Human review UX**: Gitea's PR UI is functional but basic. Is it sufficient, or
   does the GitSwarm React dashboard need its own diff viewer?

9. **Branding / positioning**: Is this "GitSwarm Platform" (a complete GitHub alternative)
   or "GitSwarm" (an agent coordination layer that happens to include git hosting)?

10. **Open source strategy**: Gitea integration is a natural open-source offering.
    Cloud features (multi-tenancy, billing, analytics) could be the commercial layer.

---

## Appendix A: Gitea API Reference

Key Gitea API endpoints used by GiteaBackend:

```
# Repository
POST   /api/v1/orgs/{org}/repos              Create repo
GET    /api/v1/repos/{owner}/{repo}           Get repo info
DELETE /api/v1/repos/{owner}/{repo}           Delete repo

# Contents
GET    /api/v1/repos/{owner}/{repo}/contents/{path}  Read file
POST   /api/v1/repos/{owner}/{repo}/contents/{path}  Create/update file
GET    /api/v1/repos/{owner}/{repo}/git/trees/{sha}  Get tree

# Branches
GET    /api/v1/repos/{owner}/{repo}/branches         List branches
POST   /api/v1/repos/{owner}/{repo}/branches         Create branch

# Pull Requests (mapped to GitSwarm streams)
POST   /api/v1/repos/{owner}/{repo}/pulls             Create PR
GET    /api/v1/repos/{owner}/{repo}/pulls/{index}     Get PR
POST   /api/v1/repos/{owner}/{repo}/pulls/{index}/merge  Merge PR
POST   /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews  Submit review

# Webhooks
POST   /api/v1/repos/{owner}/{repo}/hooks             Create webhook
GET    /api/v1/repos/{owner}/{repo}/hooks             List webhooks

# Users (auto-provisioned by GitSwarm)
POST   /api/v1/admin/users                             Create user
POST   /api/v1/admin/users/{username}/keys             Add SSH key
POST   /api/v1/users/{username}/tokens                 Create access token
```

---

## Appendix B: Relationship to Existing Design Docs

| Document | Relationship |
|----------|-------------|
| `deployment-modes.md` | This design extends Mode C (server-only) by replacing the git layer with Gitea |
| `federation-spec.md` | Governance primitives (streams, consensus, council) remain unchanged |
| `gitswarm-spec.md` | GitHub App integration becomes one backend option, not the only one |
| `DESIGN_v2.md` | React dashboard plans complement the Gitea web UI (human-facing layer) |
| `PLAN_v2.md` | Implementation phases can run in parallel with this roadmap |
| `mergify-inspired-improvements.md` | Plugin system enhancements apply regardless of git backend |

---

## Appendix C: File Change Inventory

Files that need modification or creation for Phase 1 (Steps 1-6):

### New Files

| File | Purpose |
|------|---------|
| `src/services/gitea-backend.ts` | GiteaBackend implementation |
| `src/services/gitea-admin.ts` | Gitea admin operations (user provisioning, repo creation) |
| `src/routes/webhooks-gitea.ts` | Gitea webhook handler (or merged into existing) |
| `src/routes/gitswarm/internal.ts` | Internal API for git hooks |
| `hooks/pre-receive` | Server-side pre-receive hook script |
| `hooks/post-receive` | Server-side post-receive hook script |

### Modified Files

| File | Change |
|------|--------|
| `src/services/backend-factory.ts` | Add `'gitea'` case to factory |
| `src/config/env.ts` | Add Gitea config vars |
| `src/db/migrations/` | New migration for schema generalization |
| `docker-compose.yml` | Add Gitea service |
| `.env.example` | Add Gitea env vars |
| `src/routes/webhooks.ts` | Extract shared handler logic (optional refactor) |
| `src/services/websocket.ts` | Enhance with channel-based subscriptions |
