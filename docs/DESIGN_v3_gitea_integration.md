# GitSwarm v3 Design Document: Agent-First Git Platform

> Replace GitHub dependency with self-hosted Gitea to create a lightweight, GitHub-compatible, agent-first repository management system.

**Version**: 0.2.0  
**Date**: 2026-04-03  
**Status**: Draft  
**Authors**: Alex Ngai  

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Current Architecture](#2-current-architecture)
3. [Target Architecture](#3-target-architecture)
4. [Design Decisions](#4-design-decisions) — D1-D17 resolved
5. [Gitea Integration Layer](#5-gitea-integration-layer)
6. [GitHub-Compatible API Facade](#6-github-compatible-api-facade)
7. [Git Protocol-Level Governance](#7-git-protocol-level-governance)
8. [Agent-First Extensions](#8-agent-first-extensions)
9. [Ecosystem Compatibility](#9-ecosystem-compatibility)
10. [Database Schema Changes](#10-database-schema-changes)
11. [Deployment Architecture](#11-deployment-architecture)
12. [Scaling to a Hosted Cloud Service](#12-scaling-to-a-hosted-cloud-service)
13. [Migration Path](#13-migration-path) — includes GitHub mirroring
14. [Implementation Roadmap](#14-implementation-roadmap) — Phases 1-3, 4A (MAP-native), 4B (OpenHive federation), 4C (future), 5 (cloud)

---

## 1. Motivation

### Why bypass GitHub?

GitSwarm already handles the hard parts of multi-agent coordination: consensus, council voting, karma, merge locking, staging buffers, and stabilization. GitHub serves primarily as:

- A git remote (bare repo hosting over HTTPS/SSH)
- A PR UI for human review
- Webhooks for event notifications
- Auth (tokens, SSH keys)
- CI triggers (Actions)

Agents don't need a diff viewer. They don't need a PR review UI. GitSwarm's council votes, consensus thresholds, and merge locks **are** the review process. GitHub imposes:

- **Rate limits** — agents hit API quotas at machine speed
- **Webhook latency** — polling/webhook round-trips slow coordination
- **Workflow friction** — PR-centric model forces agent governance to be hacked on top
- **Dependency risk** — GitHub App setup, OAuth, webhook signatures add operational complexity
- **Cost** — GitHub charges for Actions minutes, private repos at scale

### Why Gitea?

| Factor | GitLab CE | Gitea/Forgejo | Raw bare repos |
|--------|-----------|---------------|----------------|
| RAM per instance | 4-8 GB | 128-256 MB | ~0 |
| Binary size | ~1 GB (Rails + deps) | ~40 MB | N/A |
| Startup time | 30-60s | <1s | N/A |
| GitHub API compat | Own API | Yes (`/api/v1/`) | None |
| Embeddability | Impossible | Feasible (Go) | Full control |
| Ecosystem tool support | Moderate | High (GitHub-compatible) | None |
| CI runner | GitLab Runner | act_runner (Actions-compat) | None |
| Web UI for humans | Full-featured | Lightweight, adequate | None |

Gitea/Forgejo is the right fit: lightweight enough to run per-tenant, GitHub-compatible enough for ecosystem tools, and simple enough to embed as infrastructure rather than fight as a platform.

---

## 2. Current Architecture

### What exists today

```
┌─────────────────────────────────────────────────────────────┐
│                      GitSwarm Server                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Fastify API  │  │ Governance   │  │ Plugin Engine     │  │
│  │ /api/v1/     │  │ Engine       │  │ (3-tier: auto,    │  │
│  │ + WebSocket  │  │ (council,    │  │  AI dispatch,     │  │
│  │              │  │  consensus,  │  │  governance)      │  │
│  │              │  │  karma)      │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────────┘  │
│         │                 │                  │               │
│  ┌──────▼─────────────────▼──────────────────▼────────────┐  │
│  │              GitBackend Interface                       │  │
│  │  ┌─────────────────┐     ┌──────────────────────────┐  │  │
│  │  │ GitHubBackend   │     │ CascadeBackend           │  │  │
│  │  │ (REST API calls │     │ (server-side git-cascade, │  │  │
│  │  │  to github.com) │     │  local worktrees, SQLite) │  │  │
│  │  └─────────────────┘     └──────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐   │
│  │PostgreSQL│  │  Redis   │  │ Webhook Handler          │   │
│  │(pgvector)│  │(cache/   │  │ (GitHub events →         │   │
│  │          │  │ pub/sub) │  │  stream/review/merge)    │   │
│  └──────────┘  └──────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         ▲                              ▲
         │ REST API                     │ Webhooks
         │                              │
    ┌────┴─────┐                  ┌─────┴──────┐
    │  Agents  │                  │  GitHub    │
    │  (HTTP)  │                  │  (remote)  │
    └──────────┘                  └────────────┘
```

### Key abstractions already in place

| Abstraction | File | Purpose |
|-------------|------|---------|
| `GitBackend` | `src/services/git-backend.ts` | Interface for git ops (read, write, branch, merge) |
| `GitHubBackend` | `src/services/github-backend.ts` | GitHub REST API implementation |
| `CascadeBackend` | `src/services/cascade-backend.ts` | Server-side git-cascade implementation |
| `git_backend` column | `gitswarm_repos` | Per-repo backend selection (`'github'` or `'cascade'`) |
| Webhook handler | `src/routes/webhooks.ts` | Processes GitHub events → governance actions |
| Plugin engine | `src/services/plugin-engine.ts` | Event-triggered automation (3-tier) |

The `GitBackend` interface is the critical enabling abstraction. Adding a Gitea backend requires implementing the same interface — no changes to governance logic, streams, or consensus.

---

## 3. Target Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                       GitSwarm Platform                            │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │              Agent Coordination Layer                       │   │
│  │  Streams, Council, Consensus, Karma, Tasks, Plugins,       │   │
│  │  Merge Locks, Stabilization, Promotion, Stage Progression  │   │
│  └────────────────────────┬───────────────────────────────────┘   │
│                           │                                       │
│  ┌────────────────────────▼───────────────────────────────────┐   │
│  │         GitHub-Compatible API Facade (/api/v3/)             │   │
│  │  Maps: PRs↔Streams, Reviews↔Consensus, Issues↔Tasks        │   │
│  │  Passthrough: git refs, trees, blobs, branches, tags        │   │
│  └────────────────────────┬───────────────────────────────────┘   │
│                           │                                       │
│  ┌────────────────────────▼───────────────────────────────────┐   │
│  │              GitBackend Interface                            │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │   │
│  │  │ GitHub   │  │ Gitea        │  │ Cascade              │  │   │
│  │  │ Backend  │  │ Backend      │  │ Backend              │  │   │
│  │  │ (legacy) │  │ (primary)    │  │ (Mode C local)       │  │   │
│  │  └──────────┘  └──────────────┘  └──────────────────────┘  │   │
│  └────────────────────────────────────────────────────────────┘   │
│                           │                                       │
│  ┌────────────────────────▼───────────────────────────────────┐   │
│  │         Gitea (embedded sidecar)                            │   │
│  │  - Bare repo hosting (SSH + HTTP)                           │   │
│  │  - Git protocol server                                      │   │
│  │  - act_runner (GitHub Actions-compatible CI)                │   │
│  │  - Web UI for human browsing (optional)                     │   │
│  │  - Webhooks → GitSwarm event bus                            │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────────┐    │
│  │PostgreSQL│  │  Redis   │  │ Event Bus                    │    │
│  │          │  │  (events │  │ (Redis pub/sub + WebSocket   │    │
│  │          │  │   + cache│  │  for real-time agent comms)  │    │
│  └──────────┘  └──────────┘  └──────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

### Design principles

1. **Gitea is infrastructure, not product** — agents never interact with Gitea directly. GitSwarm owns the API surface. Gitea is a swappable git hosting layer.
2. **Governance at every level** — application-layer consensus checks AND git pre-receive hook enforcement. An agent cannot bypass governance even with direct git access.
3. **GitHub compatibility is a facade** — external tools see a GitHub-shaped API. Internally, operations map to GitSwarm's richer governance primitives.
4. **Progressive enhancement** — GitHub backend remains supported for users who want it. Gitea is the default for self-hosted deployments.

---

## 4. Design Decisions

The following questions were evaluated during the design process. Decisions are recorded here as the canonical reference.

### D1: Unified webhook endpoint

**Decision:** Single `/webhooks/git` endpoint with auto-detection via headers.

**Rationale:** GitHub and Gitea payloads are ~95% identical. A single handler checks `X-Gitea-Event` vs `X-GitHub-Event` headers and dispatches accordingly. Avoids duplicating handler logic and naturally extends to future backends (Forgejo, etc.) without new routes.

### D2: 1:1 agent-to-Gitea-user mapping

**Decision:** Create one Gitea user per GitSwarm agent.

**Rationale:** Preserves git authorship in commit metadata, enables per-agent push permissions, and maintains an audit trail at the git level. The `gitswarm_agent_gitea_users` table stores the mapping. `GiteaAdmin.createAgentUser()` runs during agent registration. Gitea handles thousands of users with negligible overhead.

A single admin user would be simpler but loses authorship, per-agent restrictions, and auditability — all critical for an agent-first platform.

### D3: Per-repo numeric stream/issue numbers

**Decision:** Add auto-increment `stream_number` column for `/api/v3/` compatibility.

**Rationale:** GitHub clients expect `pulls/42`, not `pulls/a1b2c3d4-...`. The UUID remains the internal primary key. `stream_number` is the external-facing alias used in the GitHub-compatible facade and in Gitea PR mapping. Same pattern for tasks (`task_number`) → GitHub issues.

```sql
-- Per-repo auto-increment via sequence or trigger
ALTER TABLE gitswarm_streams ADD COLUMN stream_number INTEGER;
-- Unique per repo: UNIQUE(repo_id, stream_number)
```

### D4: Shared PostgreSQL, separate databases

**Decision:** Gitea and GitSwarm share a PostgreSQL instance with separate databases.

**Rationale:** Single backup target, avoids Gitea's SQLite concurrency limitations under load, simpler ops. The databases are fully isolated (`CREATE DATABASE gitea OWNER gitea`) — no shared tables, no coupling. Aligns with the multi-tenant path where everything is already PG.

### D5: Expose Gitea web UI as secondary

**Decision:** Make Gitea's web UI accessible for code browsing/diffs, but GitSwarm's React dashboard is the primary entry point.

**Rationale:** Gitea gives you a code browser, diff viewer, and file explorer for free. Don't rebuild what Gitea provides. Link to Gitea from the GitSwarm dashboard for "view source" / "browse files" actions. Long-term, a code browser may be embedded in the dashboard, but that's Phase 4+.

### D6: GitHub mirroring in roadmap

**Decision:** Support GitHub as a read-only mirror of the Gitea primary. Scheduled for Phase 3.

**Rationale:** Important for discoverability (people find projects on GitHub), gradual migration (governance on Gitea, mirror on GitHub), and CI that still runs on GitHub Actions during transition. Gitea has built-in mirror support (`POST /api/v1/repos/migrate` with `mirror: true`), so implementation cost is low. Also supports the reverse: importing a GitHub repo into Gitea as the primary with a push mirror back to GitHub.

### D7: Self-hosted first, cloud when pulled

**Decision:** Ship self-hosted (Docker Compose) as the primary deployment. Build cloud only when demand justifies it.

**Rationale:** Self-hosted validates the product with real users. The Docker Compose setup IS the cloud artifact (each tenant gets one). Cloud infra (API gateway, billing, tenant provisioning) is expensive to build speculatively. Design tenant-awareness into the data model now (namespace by `org_id` — already done), but defer the orchestration layer.

### D8: CLI unaffected

**Decision:** Gitea integration is a server-side (Mode B/C) concern. CLI (Mode A) requires no changes.

**Rationale:** The CLI uses local SQLite + git-cascade on the filesystem. When syncing to a web server, the server may return Gitea clone URLs instead of GitHub ones. The CLI doesn't care — it speaks git protocol regardless of remote location.

### D9: Dual hook strategy

**Decision:** Use both Gitea API webhooks (for event notification) and filesystem pre-receive hooks (for enforcement).

**Rationale:** Webhooks survive Gitea upgrades and handle event flow (push, PR, review → GitSwarm event bus). Filesystem `pre-receive` hooks are the governance gate — without them, agents could bypass the API and push directly. For upgrade resilience: a startup health check verifies hooks exist and reinstalls via `GiteaAdmin.installServerHooks()` if missing.

### D10: Token lifecycle tied to agent lifecycle

**Decision:** Long-lived Gitea tokens, rotated when GitSwarm API keys rotate.

**Rationale:** GitSwarm manages agent identity. Tie lifecycles together:
- Agent created → Gitea user + token created
- Agent API key rotated → old Gitea token revoked, new one issued
- Agent deactivated → Gitea token revoked, Gitea user disabled

Gitea tokens don't expire by default, which is fine for self-hosted. For cloud, add expiration + auto-renewal.

### D11: GitSwarm coordinates git artifacts, OpenHive coordinates swarms

**Decision:** GitSwarm owns governance of git artifacts (streams, branches, merge ordering, consensus, stabilization). OpenHive owns swarm-level orchestration (agent discovery, task decomposition, assignment, session tracking). Neither replaces the other.

**Rationale:** GitSwarm already has deep git integration (Gitea backend, pre-receive hooks, buffer model). OpenHive already has swarm management, MAP hub, and task coordination. Duplicating either system's strengths in the other creates maintenance burden and architectural confusion. The boundary is clean: OpenHive decides *who does what*; GitSwarm enforces *how it gets into the repo*.

**How to apply:** The swarm endpoint (`POST /repos/:id/swarm`) accepts pre-decomposed work (agent assignments + stream dependencies) and sets up the git infrastructure. It does NOT decide which agent works on what — that comes from OpenHive or the caller.

### D12: MAP as the native real-time protocol (Level 2)

**Decision:** GitSwarm speaks MAP natively. The `/ws` endpoint is a MAP server, not a custom WebSocket protocol. Agents connect via the MAP SDK, register with their GitSwarm identity, join repo scopes, and receive events via MAP subscriptions.

**Rationale:** MAP already provides everything GitSwarm needs for real-time: filtered subscriptions, backpressure, causal ordering, reconnection with event replay, federation, and agent-to-agent messaging. Building a custom event system would duplicate MAP's capabilities and create a migration burden when connecting to OpenHive. Since we control MAP and it's already the protocol for the rest of the ecosystem, adopting it natively in Phase 4A (not 4B) avoids a costly later migration.

**What MAP replaces:**
- `WebSocketService` broadcast → MAP EventBus with typed events
- Custom Redis pub/sub channel → MAP event delivery (backed by Redis for multi-pod)
- No filtering (firehose) → MAP subscriptions with `eventTypes` + `fromScopes` filters
- No reconnection handling → MAP session resume + event replay

**What stays unchanged:**
- REST API (`/api/v1/`, `/api/v3/`) — CRUD operations remain HTTP
- Gitea integration — git operations, webhooks, pre-receive hooks
- Database — agents, streams, reviews, merges in PostgreSQL

### D13: Agent identity — GitSwarm UUID as MAP agent ID

**Decision:** GitSwarm UUID is the canonical agent ID within GitSwarm's MAP server. Agents present their API key during MAP `agents/register`. The server resolves it to the existing `agents` table row and uses the GitSwarm UUID as the MAP agent ID.

**Rationale:** GitSwarm agents are persistent entities with karma, reviews, and permissions. MAP agents are transient connection-scoped registrations. The persistent identity lives in GitSwarm's database; the MAP registration links the connection to that identity. The client is responsible for presenting its API key — the server resolves it.

**Flow:**
1. Agent connects: `ws://gitswarm/ws` → MAP `connect` handshake
2. Agent calls `agents/register` with `metadata: { api_key: "bh_xxx" }`
3. GitSwarm MAP server: `hash(api_key)` → lookup in `agents` table → found UUID
4. MAP `AgentRegistry` stores agent with `id = GitSwarm UUID`
5. Agent is registered in MAP with its persistent GitSwarm identity

**Cross-system identity:** For linking GitSwarm agents to OpenHive swarm IDs or other systems, the `gitswarm_agent_external_identities` mapping table (Phase 4B) links identities without coupling systems.

### D14: Scope auto-join with intelligent defaults

**Decision:** Auto-join repos where the agent is a maintainer or has active streams. Explicit `scopes/join` required for other repos.

**Rationale:** Maintainers always need events from repos they govern. Agents with active streams need merge/review events for their work. Other repos generate noise. Auto-join on connect reduces setup friction; explicit join gives agents control.

**Auto-join logic on agent registration:**
```sql
-- Repos where agent is maintainer/owner
SELECT repo_id FROM gitswarm_maintainers WHERE agent_id = $1
-- Repos where agent has active work
SELECT DISTINCT repo_id FROM gitswarm_streams
WHERE agent_id = $1 AND status IN ('active', 'in_review')
```

### D15: Dashboard uses separate lightweight feed

**Decision:** The React dashboard uses a simple WebSocket or SSE feed, not the MAP protocol. Events originate from MAP EventBus; a thin adapter pushes to a `dashboard:events` channel.

**Rationale:** The dashboard is a human-facing UI that needs an event stream, not the full MAP protocol. MAP is for agent-to-agent and system-to-system communication. Keeping the dashboard feed simple means no MAP SDK in the browser and no protocol overhead for human observers.

### D16: MAP extension methods + REST CRUD

**Decision:** MAP extension methods (`x-gitswarm/*`) for agent real-time operations. REST stays for CRUD and as a fallback. OpenHive uses MAP gateway for events + REST for bulk ops. External tools use REST only.

**Rationale:** When agent-1 submits a review via MAP, agent-2 (in the same scope) gets the event on the same connection in the same tick. REST requires a separate WebSocket hop. MAP makes the round-trip tighter because the operation and notification share the same transport.

**MAP extension methods (agent real-time operations):**
```
x-gitswarm/stream/create    — create stream, immediate event to scope
x-gitswarm/stream/review    — submit review, triggers consensus check
x-gitswarm/stream/merge     — governance-gated merge, synchronous result
x-gitswarm/consensus/check  — query live consensus state
x-gitswarm/task/claim        — claim task with optimistic locking
x-gitswarm/swarm/setup       — batch create streams with dependencies
```

**REST stays for:**
- Agent registration (`POST /agents`)
- Repo CRUD (`POST/PATCH/GET /gitswarm/repos`)
- Mirror management
- GitHub-compat facade (`/api/v3/`)
- Any operation that doesn't benefit from real-time event delivery

**Both available for overlap operations:**
- `POST /gitswarm/repos/:id/streams` (REST) = `x-gitswarm/stream/create` (MAP)
- REST is the fallback for agents that don't maintain a MAP connection

**OpenHive integration:**
- MAP gateway for bidirectional event streaming
- REST for bulk operations (import repos, set up mirrors, batch configurations)

### D17: self-driving-repo integration via event bridge

**Decision:** Medium-depth integration. GitSwarm lifecycle events (stream.merged, stabilization.failed) bridge to self-driving-repo DAG triggers. self-driving-repo outcomes feed back as GitSwarm plugin events.

**Rationale:** self-driving-repo's workflows compile to GitHub Actions YAML, which act_runner can execute on Gitea. The bridge is small (event mapping) and valuable (merged streams trigger deployment workflows automatically). Deep integration (embedding the DAG engine) is Phase 4C if needed.

---

## 5. Gitea Integration Layer

### 5.1 New backend: `GiteaBackend`

Implements the existing `GitBackend` interface by calling Gitea's REST API (`/api/v1/`).

```typescript
// src/services/gitea-backend.ts

export class GiteaBackend extends GitBackend {
  private baseUrl: string;      // e.g., http://localhost:3001
  private adminToken: string;   // Gitea admin API token
  
  async readFile(repoId: string, path: string, ref?: string): Promise<FileResult> {
    // GET /api/v1/repos/{owner}/{repo}/contents/{path}?ref={ref}
    // Gitea returns { content: base64, path, sha, ... }
    // Nearly identical to GitHub's Contents API
  }

  async createBranch(repoId: string, name: string, fromRef: string): Promise<Record<string, any>> {
    // POST /api/v1/repos/{owner}/{repo}/branches
    // Body: { new_branch_name, old_branch_name }
  }

  async createPullRequest(repoId: string, prData: PullRequestData): Promise<Record<string, any>> {
    // POST /api/v1/repos/{owner}/{repo}/pulls
    // Body: { title, body, head, base }
    // Response shape matches GitHub's PR object
  }

  async mergePullRequest(repoId: string, prNumber: number | string, options?: Record<string, any>): Promise<Record<string, any>> {
    // POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge
    // Body: { Do: "merge"|"rebase"|"squash" }
  }

  async getCloneAccess(repoId: string): Promise<CloneAccessResult> {
    // Returns Gitea clone URL with token auth
    // http://x-access-token:{token}@gitea:3001/{owner}/{repo}.git
  }
}
```

Because Gitea intentionally mirrors GitHub's API structure, most methods are straightforward URL + payload translations.

### 5.2 Backend selection

Extend the existing `git_backend` enum:

```
'github'  → GitHubBackend (existing)
'cascade' → CascadeBackend (existing, Mode C)
'gitea'   → GiteaBackend (new, default for self-hosted)
```

The `backend-factory.ts` already dispatches on this column. Add the new case:

```typescript
// src/services/backend-factory.ts
export function getBackendForRepo(repo: RepoRecord): GitBackend {
  switch (repo.git_backend) {
    case 'github':  return new GitHubBackend(/* ... */);
    case 'cascade': return new CascadeBackend(/* ... */);
    case 'gitea':   return new GiteaBackend(config.GITEA_URL, config.GITEA_ADMIN_TOKEN);
    default:        return new GitHubBackend(/* ... */);
  }
}
```

### 5.3 Webhook wiring: Gitea → GitSwarm

Gitea sends webhooks with the same event names and nearly identical payload structures as GitHub. The existing webhook handler (`src/routes/webhooks.ts`) needs minimal changes:

| Concern | GitHub | Gitea | Change needed |
|---------|--------|-------|---------------|
| Event header | `X-GitHub-Event` | `X-Gitea-Event` | Read both headers |
| Signature | HMAC-SHA256 (`X-Hub-Signature-256`) | HMAC-SHA256 (`X-Gitea-Signature`) | Check both headers |
| PR payload | `pull_request.number`, `.head.ref`, etc. | Same structure | None |
| Push payload | `ref`, `commits[]`, `repository` | Same structure | None |
| Review payload | `review.state`, `review.body` | Same structure | None |
| Delivery ID | `X-GitHub-Delivery` | `X-Gitea-Delivery` | Read both headers |

New webhook endpoint:

```
POST /webhooks/gitea   →  same handler logic as /webhooks/github
                           discriminated by header detection
```

Or unify into a single `POST /webhooks/git` endpoint that auto-detects the source.

### 5.4 Gitea admin operations

GitSwarm needs to manage Gitea repos programmatically (create org, create repo, configure webhooks, install hooks):

```typescript
// src/services/gitea-admin.ts

export class GiteaAdmin {
  // Create a Gitea org matching the GitSwarm org
  async createOrg(name: string): Promise<void>;
  
  // Create a repo in Gitea when a GitSwarm repo is registered
  async createRepo(orgName: string, repoName: string, isPrivate: boolean): Promise<GiteaRepo>;
  
  // Install webhook pointing back to GitSwarm
  async installWebhook(orgName: string, repoName: string, events: string[]): Promise<void>;
  
  // Install server-side hooks (pre-receive, post-receive)
  async installServerHooks(orgName: string, repoName: string): Promise<void>;
  
  // Mirror/import an existing GitHub repo into Gitea
  async mirrorFromGitHub(githubUrl: string, orgName: string, repoName: string): Promise<void>;
  
  // Create a Gitea user mapped to a GitSwarm agent
  async createAgentUser(agentId: string, agentName: string): Promise<GiteaUser>;
  
  // Generate access token for an agent
  async createAgentToken(giteaUserId: number): Promise<string>;
}
```

### 5.5 Repo lifecycle

When a new repo is registered in GitSwarm:

```
1. Agent calls POST /api/v1/gitswarm/repos
2. GitSwarm creates gitswarm_repos row (git_backend='gitea')
3. GitSwarm calls GiteaAdmin.createRepo()
   → Gitea creates bare repo on disk
4. GitSwarm calls GiteaAdmin.installWebhook()
   → Gitea will POST events to /webhooks/gitea
5. GitSwarm calls GiteaAdmin.installServerHooks()
   → pre-receive hook calls GitSwarm governance API
6. GitSwarm stores gitea_repo_id, gitea_url in DB
7. Agent receives clone URL + token for pushing
```

---

## 6. GitHub-Compatible API Facade

### 6.1 Purpose

External tools (Renovate, CI bots, IDE integrations, `gh` CLI) speak GitHub's REST API. By exposing a `/api/v3/` surface that translates to GitSwarm operations, these tools work with GitSwarm as if it were GitHub.

### 6.2 Route mapping

New route prefix: `/api/v3/` (GitHub REST API version)

| GitHub endpoint | GitSwarm handler | Notes |
|-----------------|------------------|-------|
| `GET /repos/:owner/:repo` | `gitswarm_repos` lookup | Map fields to GitHub shape |
| `GET /repos/:owner/:repo/pulls` | List `gitswarm_streams` | Streams appear as PRs |
| `POST /repos/:owner/:repo/pulls` | Create stream | Branch becomes a governed stream |
| `GET /repos/:owner/:repo/pulls/:id` | Get stream | With consensus state |
| `POST /repos/:owner/:repo/pulls/:id/reviews` | Submit stream review | Maps to consensus voting |
| `PUT /repos/:owner/:repo/pulls/:id/merge` | Merge stream | **Governance-gated**: only succeeds if consensus met |
| `GET /repos/:owner/:repo/issues` | List `gitswarm_tasks` | Tasks appear as issues |
| `POST /repos/:owner/:repo/issues` | Create task | |
| `GET /repos/:owner/:repo/git/refs/*` | Passthrough to Gitea | |
| `GET /repos/:owner/:repo/branches` | Passthrough to Gitea | |
| `GET /repos/:owner/:repo/contents/:path` | Passthrough to Gitea | |
| `POST /repos/:owner/:repo/hooks` | Manage GitSwarm webhooks | |
| `GET /user` | Current agent identity | |
| `POST /repos/:owner/:repo/dispatches` | Trigger plugin | Maps to plugin engine |

### 6.3 The key translation: Pull Requests = Streams

This is the most important mapping. When an external tool creates a "PR", it creates a GitSwarm stream with full governance:

```typescript
// POST /api/v3/repos/:owner/:repo/pulls
async function createPullRequest(req, reply) {
  const { title, head, base, body } = req.body;
  
  const stream = await createStream({
    repo_id: repo.id,
    branch: head,
    base_branch: base,
    name: title,
    source: 'github_compat',
    agent_id: req.agent.id,
  });
  
  // Return GitHub-shaped response
  return {
    number: stream.id,  // or a numeric alias
    state: stream.status === 'active' ? 'open' : stream.status,
    title: stream.name,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    body,
    user: { login: agent.name, id: agent.id },
    mergeable: consensusResult.reached,
    // ... additional fields GitHub clients expect
  };
}
```

Merging a "PR" triggers governance checks:

```typescript
// PUT /api/v3/repos/:owner/:repo/pulls/:id/merge
async function mergePullRequest(req, reply) {
  const consensus = await checkConsensus(stream, repo);
  
  if (!consensus.reached) {
    return reply.status(405).send({
      message: 'Consensus not reached',
      documentation_url: 'https://gitswarm.dev/docs/consensus',
      // Extended fields for GitSwarm-aware clients
      consensus: {
        threshold: consensus.threshold,
        current_ratio: consensus.ratio,
        approvals: consensus.approvals,
        rejections: consensus.rejections,
      }
    });
  }
  
  // Proceed with governance-approved merge
  await mergeStream(stream.id, repo);
  return { merged: true, sha: mergeCommit };
}
```

### 6.4 What passes through to Gitea vs what GitSwarm handles

| Category | Handler | Rationale |
|----------|---------|-----------|
| Git objects (refs, trees, blobs, commits) | **Passthrough** to Gitea | Pure git data, no governance |
| File contents, branches, tags | **Passthrough** to Gitea | Read-only git operations |
| Repository CRUD | **GitSwarm** (creates in both Gitea + DB) | Repo = governance entity |
| Pull requests | **GitSwarm streams** | PR = governed stream |
| PR reviews | **GitSwarm reviews** | Review = consensus vote |
| PR merge | **GitSwarm merge** | Merge = governance-gated |
| Issues | **GitSwarm tasks** | Issue = task with bounty |
| Webhooks config | **GitSwarm** | Manages internal + Gitea hooks |
| Users / auth | **GitSwarm agents** | Agent identity is first-class |
| Actions / CI | **GitSwarm plugins** or act_runner | Plugin engine dispatches |

### 6.5 Auth for the facade

GitHub clients authenticate with `Authorization: Bearer <token>` or `Authorization: token <token>`. Map these to GitSwarm agent API keys:

```typescript
// Middleware for /api/v3/
function githubCompatAuth(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') || auth?.startsWith('token ')) {
    const token = auth.split(' ')[1];
    // Look up agent by API key hash
    const agent = await findAgentByApiKey(token);
    req.agent = agent;
  }
}
```

This means the `gh` CLI, Renovate, and other tools can authenticate using GitSwarm agent API keys in place of GitHub PATs.

---

## 7. Git Protocol-Level Governance

### 7.1 Server-side hooks

Install hooks in Gitea's bare repos to enforce governance at the git protocol level. Even if an agent bypasses the API and pushes directly via git, governance rules are enforced.

#### pre-receive hook

Called before Gitea accepts a push. Calls GitSwarm API to validate:

```bash
#!/bin/bash
# Installed at: {gitea-data}/gitea-repositories/{owner}/{repo}.git/hooks/pre-receive

GITSWARM_API="http://localhost:3000/api/v1/internal/git/pre-receive"

while read oldrev newrev refname; do
  RESULT=$(curl -sf "$GITSWARM_API" \
    -H "X-Internal-Secret: $GITSWARM_INTERNAL_SECRET" \
    -d "{
      \"repo_path\": \"$(pwd)\",
      \"ref\": \"$refname\",
      \"old_sha\": \"$oldrev\",
      \"new_sha\": \"$newrev\",
      \"pusher\": \"$GITEA_PUSHER_NAME\"
    }")
  
  ALLOWED=$(echo "$RESULT" | jq -r '.allowed')
  if [ "$ALLOWED" != "true" ]; then
    REASON=$(echo "$RESULT" | jq -r '.reason')
    echo "GitSwarm: push denied — $REASON" >&2
    exit 1
  fi
done
```

#### GitSwarm pre-receive API

```typescript
// POST /api/v1/internal/git/pre-receive
// Internal endpoint, only accessible from Gitea hooks

async function handlePreReceive(req, reply) {
  const { repo_path, ref, old_sha, new_sha, pusher } = req.body;
  const repo = await findRepoByGiteaPath(repo_path);
  
  // Rule 1: Protected branches require consensus
  if (isProtectedBranch(repo, ref)) {
    // Only GitSwarm merge operations should push to protected branches
    const pendingMerge = await findPendingMergeForSha(repo.id, new_sha);
    if (!pendingMerge) {
      return { allowed: false, reason: 'Direct push to protected branch denied. Use a stream.' };
    }
  }
  
  // Rule 2: Buffer branch — only merged streams
  if (ref === `refs/heads/${repo.buffer_branch}`) {
    const stream = await findStreamForMerge(repo.id, new_sha);
    if (!stream || stream.status !== 'approved') {
      return { allowed: false, reason: 'Buffer branch only accepts consensus-approved merges.' };
    }
  }
  
  // Rule 3: Stream branches — only the owning agent (or with permission)
  if (ref.startsWith('refs/heads/stream/')) {
    const streamName = ref.replace('refs/heads/', '');
    const stream = await findStreamByBranch(repo.id, streamName);
    if (stream && stream.agent_id !== pusherAgentId) {
      const perm = await checkPermission(repo.id, pusherAgentId);
      if (perm.level !== 'maintain' && perm.level !== 'admin') {
        return { allowed: false, reason: 'Only the stream owner or maintainers can push to this branch.' };
      }
    }
  }
  
  return { allowed: true };
}
```

#### post-receive hook

Fires after a successful push. Used for event propagation:

```bash
#!/bin/bash
# Notify GitSwarm of successful pushes (async, non-blocking)

while read oldrev newrev refname; do
  curl -sf "http://localhost:3000/api/v1/internal/git/post-receive" \
    -H "X-Internal-Secret: $GITSWARM_INTERNAL_SECRET" \
    -d "{
      \"repo_path\": \"$(pwd)\",
      \"ref\": \"$refname\",
      \"old_sha\": \"$oldrev\",
      \"new_sha\": \"$newrev\",
      \"pusher\": \"$GITEA_PUSHER_NAME\"
    }" &
done
```

This supplements Gitea webhooks — it's faster (no HTTP round-trip through Gitea's webhook queue) and catches pushes that Gitea might not emit events for.

---

## 8. Agent-First Extensions

Beyond GitHub compatibility, expose endpoints that GitHub doesn't have — the agent-native API that makes GitSwarm's value proposition.

### 8.1 Agent-native endpoints (existing + new)

These exist under `/api/v1/` (GitSwarm's native API) and are the primary API for GitSwarm-aware agents:

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `POST /api/v1/gitswarm/repos/:id/streams` | Create stream (richer than PR) | Exists |
| `GET /api/v1/gitswarm/repos/:id/streams/:sid/consensus` | Real-time consensus state | **New** |
| `POST /api/v1/gitswarm/repos/:id/streams/:sid/reviews` | Submit review with karma weight | Exists |
| `GET /api/v1/gitswarm/repos/:id/council` | Council state, proposals, votes | Exists |
| `POST /api/v1/gitswarm/repos/:id/council/proposals` | Create governance proposal | Exists |
| `GET /api/v1/agents/:id/karma` | Agent reputation | Exists |
| `POST /api/v1/gitswarm/repos/:id/stabilize` | Trigger buffer stabilization | **New** |
| `POST /api/v1/gitswarm/repos/:id/promote` | Promote buffer → main | **New** |
| `GET /api/v1/events/subscribe` | WebSocket event stream | **New** |
| `POST /api/v1/gitswarm/repos/:id/swarm` | Coordinate multi-agent task | **New** |

### 8.2 Real-time event streaming

Replace webhook polling with a native event bus. Agents subscribe via WebSocket and receive events in real-time:

```typescript
// GET /api/v1/events/subscribe?repos=repo1,repo2&events=stream.*,merge.*

// Event types:
// stream.created, stream.updated, stream.merged, stream.abandoned
// review.submitted, review.updated  
// consensus.reached, consensus.lost
// merge.started, merge.completed, merge.failed
// stabilization.started, stabilization.passed, stabilization.failed
// promotion.completed
// council.proposal_created, council.vote_cast, council.proposal_resolved
// task.created, task.claimed, task.completed
// plugin.executed
```

Implementation: Redis pub/sub channels per repo, fanned out to WebSocket connections. This is an extension of the existing `WebSocketService` in `src/services/websocket.ts`.

### 8.3 Swarm coordination endpoint

A higher-level API for orchestrating multi-agent work on a single task:

```typescript
// POST /api/v1/gitswarm/repos/:id/swarm
{
  "task_id": "uuid",
  "agents": ["agent-1", "agent-2", "agent-3"],
  "strategy": "parallel_streams",  // or "sequential", "review_chain"
  "decomposition": [
    { "agent": "agent-1", "scope": "src/services/**", "description": "Implement backend" },
    { "agent": "agent-2", "scope": "src/routes/**", "description": "Implement API routes" },
    { "agent": "agent-3", "scope": "tests/**", "description": "Write tests" }
  ]
}
```

This creates streams, assigns work, and coordinates merge ordering — the full agent-first workflow that has no GitHub equivalent.

---

## 9. Ecosystem Compatibility

### 9.1 Tools that work with Gitea out of the box

| Tool | GitHub support | Gitea support | Notes |
|------|---------------|---------------|-------|
| **Renovate** | Native | Native | Dependency updates. Has first-class Gitea platform support |
| **act** (local Actions runner) | Native | Via act_runner | Gitea's CI runner is built on act |
| **Drone CI** | Yes | First-class | Dedicated Gitea integration |
| **pre-commit.ci** | Yes | Via webhooks | Webhook-triggered |
| **IDE git integration** | N/A | Automatic | Any IDE that speaks git protocol |
| **Terraform Gitea provider** | N/A | Yes | IaC for repo management |
| **`gh` CLI** | Native | Partial | Can point at Gitea via `GH_HOST` |
| **Dependabot** | GitHub-only | No | Use Renovate instead |
| **GitHub Actions** | GitHub-only | act_runner compat | Most workflows run unmodified |

### 9.2 Actions compatibility via act_runner

Gitea includes `act_runner`, a GitHub Actions-compatible CI runner. Most `.github/workflows/*.yml` files work unmodified. Integration with GitSwarm:

```
1. Push to stream branch → Gitea webhook → GitSwarm
2. GitSwarm plugin engine evaluates trigger conditions
3. If plugin matches: dispatch to act_runner (or built-in action)
4. act_runner runs the workflow in an isolated container
5. On completion: callback to GitSwarm with results
6. GitSwarm updates stream status, triggers consensus check
```

This replaces the current `workflow_run` webhook handler and the GitHub Actions dispatch mechanism in the plugin engine.

### 9.3 What requires adaptation

| Feature | GitHub | Gitea/GitSwarm alternative |
|---------|--------|---------------------------|
| GitHub Apps | OAuth + JWT auth | Agent API keys + Gitea OAuth2 |
| GitHub Checks API | Status checks on PRs | Stream status + act_runner results |
| GitHub Deployments | Deploy environments | Plugin-triggered deployment |
| GitHub Packages | Container/npm registry | Gitea packages (built-in) |
| GitHub Pages | Static site hosting | External (Cloudflare Pages, etc.) |
| GitHub Copilot | AI code completion | N/A (not a platform concern) |
| GitHub Security Advisories | Vulnerability DB | Renovate vulnerability scanning |

---

## 10. Database Schema Changes

### 10.1 Migration: Generalize GitHub-specific columns

```sql
-- Migration 006: Gitea integration and schema generalization

-- Add 'gitea' to the backend enum
-- (Already extensible via VARCHAR, just document the new value)

-- Gitea-specific columns on gitswarm_repos
ALTER TABLE gitswarm_repos
  ADD COLUMN IF NOT EXISTS gitea_repo_id BIGINT,
  ADD COLUMN IF NOT EXISTS gitea_owner VARCHAR(100),
  ADD COLUMN IF NOT EXISTS gitea_repo_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS gitea_url TEXT;

-- Index for Gitea repo lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_gitswarm_repos_gitea
  ON gitswarm_repos (gitea_repo_id)
  WHERE gitea_repo_id IS NOT NULL;

-- Gitea-specific columns on gitswarm_orgs
ALTER TABLE gitswarm_orgs
  ADD COLUMN IF NOT EXISTS gitea_org_id BIGINT,
  ADD COLUMN IF NOT EXISTS gitea_org_name VARCHAR(100);

-- Generalize stream source tracking
-- Existing: source='cli'|'github', github_pr_number, github_pr_url
-- Add: gitea equivalents
ALTER TABLE gitswarm_streams
  ADD COLUMN IF NOT EXISTS gitea_pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_pr_url TEXT;

-- Update source enum documentation: 'cli' | 'github' | 'gitea' | 'github_compat'

-- Generalize task issue tracking  
ALTER TABLE gitswarm_tasks
  ADD COLUMN IF NOT EXISTS gitea_issue_number INTEGER,
  ADD COLUMN IF NOT EXISTS gitea_issue_url TEXT;

-- Agent-to-Gitea-user mapping
CREATE TABLE IF NOT EXISTS gitswarm_agent_gitea_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  gitea_user_id BIGINT NOT NULL,
  gitea_username VARCHAR(100) NOT NULL,
  gitea_token_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id),
  UNIQUE(gitea_user_id)
);
CREATE INDEX idx_agent_gitea_users_agent ON gitswarm_agent_gitea_users(agent_id);

-- Internal merge tracking for pre-receive hook validation
CREATE TABLE IF NOT EXISTS gitswarm_pending_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  stream_id VARCHAR(36) REFERENCES gitswarm_streams(id),
  expected_sha VARCHAR(40),
  status VARCHAR(20) DEFAULT 'pending',  -- pending, completed, expired
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);
CREATE INDEX idx_pending_merges_repo_sha
  ON gitswarm_pending_merges (repo_id, expected_sha)
  WHERE status = 'pending';
```

### 10.2 No breaking changes

All new columns are additive (`ADD COLUMN IF NOT EXISTS`). Existing GitHub-backed repos continue working unchanged. The `git_backend` column already supports extensibility.

---

## 11. Deployment Architecture

### 11.1 Self-hosted: Docker Compose (default)

The primary deployment target. Single command to get GitSwarm + Gitea running:

```yaml
# docker-compose.yml (updated)

version: '3.8'

services:
  # GitSwarm API server
  api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: gitswarm-api
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      HOST: 0.0.0.0
      DATABASE_URL: postgresql://gitswarm:gitswarm_password@postgres:5432/gitswarm
      REDIS_URL: redis://redis:6379
      SESSION_SECRET: ${SESSION_SECRET}
      # Gitea integration
      GITEA_URL: http://gitea:3000
      GITEA_ADMIN_TOKEN: ${GITEA_ADMIN_TOKEN}
      GITEA_INTERNAL_SECRET: ${GITEA_INTERNAL_SECRET}
      # Optional: GitHub (for hybrid mode)
      GITHUB_APP_ID: ${GITHUB_APP_ID:-}
      GITHUB_PRIVATE_KEY: ${GITHUB_PRIVATE_KEY:-}
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET:-}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      gitea:
        condition: service_healthy

  # Gitea - Git hosting
  gitea:
    image: gitea/gitea:latest
    container_name: gitswarm-gitea
    ports:
      - "3001:3000"    # Gitea web/API (external access)
      - "2222:22"      # Git SSH
    environment:
      - GITEA__database__DB_TYPE=postgres
      - GITEA__database__HOST=postgres:5432
      - GITEA__database__NAME=gitea
      - GITEA__database__USER=gitea
      - GITEA__database__PASSWD=gitea_password
      - GITEA__server__ROOT_URL=http://localhost:3001
      - GITEA__server__SSH_PORT=2222
      - GITEA__webhook__ALLOWED_HOST_LIST=api
      - GITEA__service__DISABLE_REGISTRATION=true  # GitSwarm manages users
      - GITEA__api__ENABLE_SWAGGER=false
    volumes:
      - gitea_data:/data
      - gitea_repos:/data/gitea-repositories
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000/api/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5

  # PostgreSQL (shared by GitSwarm and Gitea)
  postgres:
    image: pgvector/pgvector:pg16
    container_name: gitswarm-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-databases.sql:/docker-entrypoint-initdb.d/00-init.sql:ro
      - ./src/db/migrations:/docker-entrypoint-initdb.d/migrations:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis
  redis:
    image: redis:7-alpine
    container_name: gitswarm-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # act_runner (GitHub Actions-compatible CI) - optional
  act_runner:
    image: gitea/act_runner:latest
    container_name: gitswarm-runner
    environment:
      - GITEA_INSTANCE_URL=http://gitea:3000
      - GITEA_RUNNER_REGISTRATION_TOKEN=${RUNNER_TOKEN:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      gitea:
        condition: service_healthy

volumes:
  postgres_data:
  redis_data:
  gitea_data:
  gitea_repos:

networks:
  default:
    name: gitswarm-network
```

### 11.2 Init script for shared PostgreSQL

```sql
-- scripts/init-databases.sql
-- Creates separate databases for GitSwarm and Gitea on the same PostgreSQL instance

CREATE USER gitswarm WITH PASSWORD 'gitswarm_password';
CREATE DATABASE gitswarm OWNER gitswarm;

CREATE USER gitea WITH PASSWORD 'gitea_password';
CREATE DATABASE gitea OWNER gitea;

-- pgvector extension for GitSwarm
\c gitswarm
CREATE EXTENSION IF NOT EXISTS pgvector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### 11.3 Environment configuration

New environment variables in `src/config/env.ts`:

```typescript
interface EnvConfig {
  // ... existing vars ...
  
  // Gitea integration
  GITEA_URL?: string;               // Gitea API base URL (e.g., http://gitea:3000)
  GITEA_ADMIN_TOKEN?: string;       // Gitea admin user API token
  GITEA_INTERNAL_SECRET?: string;   // Shared secret for pre-receive hook auth
  GITEA_SSH_URL?: string;           // External SSH URL (e.g., ssh://git@localhost:2222)
  GITEA_EXTERNAL_URL?: string;      // Public-facing Gitea URL (if different from internal)
  
  // Default backend for new repos
  DEFAULT_GIT_BACKEND?: 'github' | 'gitea' | 'cascade';  // default: 'gitea' when GITEA_URL set
}
```

---

## 12. Scaling to a Hosted Cloud Service

### 12.1 Individual vs multi-tenant

The self-hosted Docker Compose setup targets individual teams. A hosted cloud service requires multi-tenancy.

### 12.2 Scaling model: Gitea-per-tenant

The recommended approach for a hosted offering:

```
┌─────────────────────────────────────────────────────────┐
│                   GitSwarm Cloud                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │            Shared Infrastructure                  │   │
│  │  API Gateway + Auth + Billing + Metrics           │   │
│  └──────────────┬────────────────────────────────────┘   │
│                 │                                        │
│  ┌──────────────▼──────────────────────────────────┐    │
│  │  Tenant Isolation (k8s namespaces / Fly machines) │    │
│  │                                                    │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │    │
│  │  │Tenant A  │  │Tenant B  │  │Tenant C  │  ...   │    │
│  │  │          │  │          │  │          │        │    │
│  │  │ GitSwarm │  │ GitSwarm │  │ GitSwarm │        │    │
│  │  │ + Gitea  │  │ + Gitea  │  │ + Gitea  │        │    │
│  │  │ instance │  │ instance │  │ instance │        │    │
│  │  └──────────┘  └──────────┘  └──────────┘        │    │
│  └───────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Shared data layer (optional)                     │   │
│  │  Managed PostgreSQL, Redis, Object Storage        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Why per-tenant isolation:**
- Strong security boundary (agent code from Tenant A never touches Tenant B)
- Simple ops (each tenant is the same Docker Compose, just scaled)
- Matches self-hosted model (same artifact deploys everywhere)
- Gitea at 128-256 MB RAM makes per-tenant instances affordable

### 12.3 Scaling bottlenecks and mitigations

| Bottleneck | Why it's hard | Mitigation |
|------------|---------------|------------|
| Git worktrees at scale | Each stream = worktree = disk I/O | Ephemeral worktrees, shallow clones, object storage |
| Merge/rebase compute | Server-side merges are CPU-bound | Queue-based processing, dedicated merge workers |
| Test execution | Stabilization = arbitrary code execution | Sandboxed containers (Firecracker, gVisor), resource limits |
| Event fanout | N agents x M repos x K events | Partitioned Redis streams or NATS per tenant |
| Git storage growth | Repos grow unboundedly | Git object dedup, aggressive pack/prune, LFS for large files |

### 12.4 Future: custom git storage layer

At serious scale (thousands of repos, terabytes), Gitea's naive on-disk storage becomes a bottleneck. Options:

1. **Gitaly standalone** — GitLab's git storage layer is Apache 2.0 licensed. Handles sharding, replication, gRPC-based ops. Can be used without the rest of GitLab.
2. **Custom sharding** — shard repos across volumes by tenant ID, use object storage (S3) for pack files.
3. **Replace Gitea's git layer** — keep Gitea's API/webhook surface, swap the storage backend.

This is a Phase 3+ concern. Don't build it until scale demands it.

### 12.5 Pricing model

Traditional per-seat pricing doesn't work for agent swarms. Options:

| Model | Metric | Fits when |
|-------|--------|-----------|
| Per-agent-hour | Active agent coordination time | Usage-based, scales with value |
| Per-merge | Governance decisions (consensus checks, merges) | Aligns with output |
| Per-repo + compute tier | Base fee + worktree/CI minutes | Predictable base + variable |
| Flat tier | Small/Medium/Large plans | Simplest for customers |

---

## 13. Migration Path

### 13.1 From GitHub-backed repos to Gitea

For existing users with GitHub-backed repos, migration is non-disruptive:

```
Step 1: Mirror GitHub repo to Gitea
  → GiteaAdmin.mirrorFromGitHub(githubUrl, org, repo)
  → Gitea creates a mirror that stays in sync

Step 2: Switch git_backend from 'github' to 'gitea'
  → UPDATE gitswarm_repos SET git_backend = 'gitea' WHERE id = ?
  → New operations go through GiteaBackend
  → GitHub mirror can continue for read-only access

Step 3: Update agent clone URLs
  → Agents receive new Gitea clone URL on next getCloneAccess() call
  → Old GitHub URLs continue working (repo still exists on GitHub)

Step 4: (Optional) Enable push mirror back to GitHub (Phase 3, D6)
  → POST /api/v1/gitswarm/repos/:id/mirrors { direction: "push" }
  → Gitea pushes to GitHub on every receive
  → GitHub stays current as a read-only mirror for discoverability

Step 5: (Optional) Disable GitHub integration entirely
  → Remove GitHub App installation
  → Delete push mirror
  → GitHub becomes a static archive
```

### 13.2 Backward compatibility

- GitHub backend remains a first-class option. The `git_backend='github'` path is unchanged.
- Orgs can mix GitHub-backed and Gitea-backed repos.
- The webhook handler supports both GitHub and Gitea events simultaneously.
- The `/api/v3/` facade works regardless of the underlying backend — it's a translation layer on top of GitSwarm's native API, not Gitea-specific.

---

## 14. Implementation Roadmap

All design decisions from [Section 4](#4-design-decisions) are incorporated into these phases.

### Phase 1: Gitea Foundation

**Goal:** Replace GitHub as the default git hosting layer for new repos. Zero GitHub dependency for new deployments.

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 1.1 | Add Gitea + shared PG init script to docker-compose.yml | Small | `docker-compose.yml`, new: `scripts/init-databases.sql` |
| 1.2 | Add Gitea env config variables | Small | `src/config/env.ts`, `.env.example` |
| 1.3 | DB migration 006: Gitea columns, `stream_number` auto-increment, `gitswarm_agent_gitea_users`, `gitswarm_pending_merges` | Medium | New: `src/db/migrations/006_gitea_integration.sql` |
| 1.4 | Create `GiteaBackend` implementing `GitBackend` interface | Medium | New: `src/services/gitea-backend.ts` |
| 1.5 | Create `GiteaAdmin` for repo/org/user/token/webhook management | Medium | New: `src/services/gitea-admin.ts` |
| 1.6 | Update `backend-factory.ts` to handle `'gitea'` backend | Small | `src/services/backend-factory.ts` |
| 1.7 | Unify webhook handler: single `/webhooks/git` endpoint with auto-detection (D1) | Medium | `src/routes/webhooks.ts` |
| 1.8 | Repo creation flow: create in both GitSwarm DB + Gitea, install webhook | Medium | `src/routes/gitswarm/index.ts` |
| 1.9 | Agent registration: auto-create Gitea user + token (D2, D10) | Medium | `src/routes/agents.ts`, `src/services/gitea-admin.ts` |

**Exit criteria:** `docker-compose up` → create a repo → agent pushes code via Gitea → webhook fires → stream created → review submitted → consensus reached → merge succeeds. All through Gitea, zero GitHub dependency.

**Dependencies:** None. This is the foundation everything else builds on.

### Phase 2: Git-Level Governance

**Goal:** Enforce governance at the git protocol layer. Even direct `git push` obeys consensus rules.

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 2.1 | `pre-receive` hook script (calls GitSwarm internal API) | Small | New: `scripts/hooks/pre-receive` |
| 2.2 | `POST /api/v1/internal/git/pre-receive` validation endpoint | Medium | New: `src/routes/internal/git-hooks.ts` |
| 2.3 | `post-receive` hook for fast event propagation | Small | New: `scripts/hooks/post-receive` |
| 2.4 | `GiteaAdmin.installServerHooks()` + startup health check for reinstall on upgrade (D9) | Medium | `src/services/gitea-admin.ts`, `src/index.ts` |
| 2.5 | Pending merge tracking: populate `gitswarm_pending_merges` before merge ops | Small | `src/routes/gitswarm/streams.ts` |
| 2.6 | Protected branch enforcement: main + buffer reject direct pushes | Medium | `src/routes/internal/git-hooks.ts` |
| 2.7 | Stream branch ownership: only owning agent (or maintainers) can push | Small | `src/routes/internal/git-hooks.ts` |

**Exit criteria:** `git push origin main` is rejected with "GitSwarm: push denied — consensus not reached". Stream branches reject pushes from non-owning agents. Buffer branch only accepts governance-approved merges.

**Dependencies:** Phase 1 complete.

### Phase 3: GitHub-Compatible Facade + Mirroring

**Goal:** External tools (Renovate, CI bots, `gh` CLI) work with GitSwarm as if it were GitHub. GitHub repos can mirror to/from Gitea.

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 3.1 | `/api/v3/` route scaffold + auth middleware (Bearer token → agent lookup) | Medium | New: `src/routes/github-compat/index.ts` |
| 3.2 | `GET/POST /repos/:owner/:repo` — repo metadata in GitHub shape | Small | New: `src/routes/github-compat/repos.ts` |
| 3.3 | `GET/POST /repos/:owner/:repo/pulls` — streams as PRs (core translation, uses `stream_number` per D3) | Large | New: `src/routes/github-compat/pulls.ts` |
| 3.4 | `POST /pulls/:id/reviews` — reviews as consensus votes | Medium | `src/routes/github-compat/pulls.ts` |
| 3.5 | `PUT /pulls/:id/merge` — governance-gated merge (returns 405 if consensus not met) | Medium | `src/routes/github-compat/pulls.ts` |
| 3.6 | `GET/POST /repos/:owner/:repo/issues` — tasks as issues (uses `task_number`) | Medium | New: `src/routes/github-compat/issues.ts` |
| 3.7 | Git data passthrough: refs, branches, tags, contents → Gitea API | Medium | New: `src/routes/github-compat/git.ts` |
| 3.8 | Webhook management: `POST /repos/:owner/:repo/hooks` | Small | New: `src/routes/github-compat/hooks.ts` |
| 3.9 | `POST /repos/:owner/:repo/dispatches` → plugin engine | Small | New: `src/routes/github-compat/dispatches.ts` |
| 3.10 | **GitHub mirror support:** import GitHub repo into Gitea + push mirror back (D6) | Medium | `src/services/gitea-admin.ts`, new: `src/routes/gitswarm/mirrors.ts` |
| 3.11 | Mirror management API: create, sync status, pause/resume, delete | Small | `src/routes/gitswarm/mirrors.ts` |

**GitHub Mirroring detail (steps 3.10-3.11):**

Three mirror modes supported via Gitea's built-in mirroring:

| Mode | Direction | Use case |
|------|-----------|----------|
| **Import mirror** | GitHub → Gitea (pull) | Migrate existing repo. Gitea periodically pulls from GitHub. |
| **Push mirror** | Gitea → GitHub (push) | Keep GitHub as read-only mirror. Gitea pushes on every receive. |
| **Bidirectional** | Import + push | Transition period: accept work on both, governance on Gitea. |

```typescript
// POST /api/v1/gitswarm/repos/:id/mirrors
{
  "github_url": "https://github.com/org/repo",
  "direction": "push",           // "pull" | "push" | "bidirectional"
  "github_token": "ghp_...",     // PAT for GitHub auth
  "sync_interval": "10m",        // For pull mirrors
  "mirror_branches": ["main", "buffer"]  // Optional: only mirror specific branches
}
```

Implementation leverages Gitea's API:
- Pull mirror: `POST /api/v1/repos/migrate` with `mirror: true`
- Push mirror: `POST /api/v1/repos/{owner}/{repo}/push-mirrors`
- Status: `GET /api/v1/repos/{owner}/{repo}/push-mirrors`

**Exit criteria:** Renovate opens dependency update "PRs" that flow through GitSwarm governance. `gh pr list` shows streams. A GitHub repo can be imported into Gitea and kept in sync as a push mirror.

**Dependencies:** Phase 1 complete. Phase 2 recommended but not strictly required (facade works without git-level enforcement, just with weaker guarantees).

### Phase 4A: MAP-Native Agent Platform

**Goal:** GitSwarm speaks MAP natively. Agents connect via the MAP SDK, register with their GitSwarm identity, join repo scopes, receive events, send messages, and invoke GitSwarm operations — all over a single connection. (See decisions D12-D16.)

**Dependency:** `@multi-agent-protocol/sdk` as an npm dependency.

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 4A.1 | MAP server setup + agent identity resolution | Medium | New: `src/services/map-server.ts` |
| 4A.2 | Replace `/ws` endpoint with MAP protocol | Small | `src/index.ts` |
| 4A.3 | GitSwarm event taxonomy + EventBus integration | Medium | New: `src/services/map-events.ts`, modify `src/services/activity.ts` |
| 4A.4 | Repo-as-scope model with auto-join | Medium | `src/services/map-server.ts` |
| 4A.5 | MAP extension methods (`x-gitswarm/*`) | Large | New: `src/services/map-handlers.ts` |
| 4A.6 | Dashboard lightweight feed (separate from MAP) | Small | `src/index.ts` |
| 4A.7 | Consensus state endpoint (REST + MAP) | Small | `src/routes/gitswarm/streams.ts`, `src/services/map-handlers.ts` |
| 4A.8 | Swarm git coordination (REST + MAP) | Medium | New: `src/routes/gitswarm/swarm.ts`, `src/services/map-handlers.ts` |
| 4A.9 | act_runner CI integration | Medium | `docker-compose.yml`, `src/services/plugin-engine.ts` |

**Step 4A.1: MAP server setup**

```typescript
// src/services/map-server.ts
import { MAPServer, websocketStream } from '@multi-agent-protocol/sdk/server';

const mapServer = new MAPServer({
  name: 'gitswarm',
  version: '0.3.0',

  // Custom agent registration: resolve API key → GitSwarm UUID
  additionalHandlers: {
    ...createGitSwarmHandlers(),  // x-gitswarm/* methods
  },
});

// Agent registration hook: link MAP agent to GitSwarm identity
mapServer.eventBus.on('agent.registered', async (event) => {
  const { agentId, metadata } = event.data;
  if (metadata?.api_key) {
    const hash = hashApiKey(metadata.api_key);
    const agent = await query('SELECT id FROM agents WHERE api_key_hash = $1', [hash]);
    if (agent.rows[0]) {
      // Store GitSwarm UUID ↔ MAP agent ID mapping
      // The MAP agent ID IS the GitSwarm UUID when possible
    }
  }
});
```

**Step 4A.3: Event taxonomy**

GitSwarm events published through MAP's EventBus, scoped to repos:

```typescript
// All events are scoped to a repo (MAP scope = repo:{uuid})
const GITSWARM_EVENTS = {
  // Stream lifecycle
  'gitswarm.stream.created':      { stream_id, branch, agent_id, stream_number },
  'gitswarm.stream.updated':      { stream_id, branch, new_sha },
  'gitswarm.stream.abandoned':    { stream_id, reason },

  // Reviews & consensus
  'gitswarm.review.submitted':    { stream_id, reviewer_id, verdict },
  'gitswarm.consensus.reached':   { stream_id, ratio, threshold, approvals },
  'gitswarm.consensus.lost':      { stream_id, ratio, reason },

  // Merge
  'gitswarm.merge.started':       { stream_id, target_branch },
  'gitswarm.merge.completed':     { stream_id, merge_commit, target_branch },
  'gitswarm.merge.failed':        { stream_id, reason },

  // Buffer lifecycle
  'gitswarm.stabilization.started':   { repo_id, buffer_commit },
  'gitswarm.stabilization.passed':    { repo_id, tag },
  'gitswarm.stabilization.failed':    { repo_id, breaking_stream_id },
  'gitswarm.promotion.completed':     { repo_id, from_branch, to_branch },

  // Governance
  'gitswarm.council.proposal_created':  { proposal_id, type },
  'gitswarm.council.vote_cast':         { proposal_id, agent_id, vote },
  'gitswarm.council.proposal_resolved': { proposal_id, result },

  // Tasks
  'gitswarm.task.created':     { task_id, title, task_number },
  'gitswarm.task.claimed':     { task_id, agent_id },
  'gitswarm.task.completed':   { task_id, stream_id },
};
```

The `ActivityService` is modified to emit to `mapServer.eventBus` instead of the old `WebSocketService.publishActivity()`. Events are published with `scope: repo:{id}` so MAP's subscription filtering works per-repo.

**Step 4A.4: Repo-as-scope model**

Each GitSwarm repo is a MAP scope. When an agent registers via MAP, auto-join logic runs:

```typescript
// On agent registration, auto-join relevant repo scopes
async function autoJoinScopes(mapServer, agentId, gitswarmAgentId) {
  // Repos where agent is maintainer/owner
  const maintained = await query(`
    SELECT repo_id FROM gitswarm_maintainers WHERE agent_id = $1
  `, [gitswarmAgentId]);

  // Repos where agent has active streams
  const active = await query(`
    SELECT DISTINCT repo_id FROM gitswarm_streams
    WHERE agent_id = $1 AND status IN ('active', 'in_review')
  `, [gitswarmAgentId]);

  const repoIds = new Set([
    ...maintained.rows.map(r => r.repo_id),
    ...active.rows.map(r => r.repo_id),
  ]);

  for (const repoId of repoIds) {
    mapServer.scopes.join(`repo:${repoId}`, agentId);
  }
}
```

Agents can explicitly `scopes/join` additional repos or `scopes/leave` repos they don't need.

**Step 4A.5: MAP extension methods**

Custom `x-gitswarm/*` methods registered as additional handlers on the MAP server. These are the primary API for MAP-connected agents:

```typescript
// src/services/map-handlers.ts
export function createGitSwarmHandlers(): HandlerRegistry {
  return {
    // Create a stream (agent gets immediate event confirmation in same scope)
    'x-gitswarm/stream/create': async (params, ctx) => {
      const { repo_id, branch, base_branch, name } = params;
      const agentId = resolveAgentFromSession(ctx.session);
      // ... create stream in DB, create branch in Gitea
      // Event auto-emitted to repo scope subscribers
      return { stream_id, stream_number, branch };
    },

    // Submit review (triggers consensus check, returns result)
    'x-gitswarm/stream/review': async (params, ctx) => {
      const { stream_id, verdict, feedback } = params;
      // ... insert review, check consensus
      return { consensus: { reached, ratio, threshold } };
    },

    // Governance-gated merge (synchronous consensus check + merge)
    'x-gitswarm/stream/merge': async (params, ctx) => {
      const { stream_id } = params;
      // ... check consensus, execute merge if reached
      // Returns 'consensus_not_reached' error if not ready
      return { merged: true, merge_commit };
    },

    // Query live consensus state
    'x-gitswarm/consensus/check': async (params, ctx) => {
      const { stream_id } = params;
      return { reached, ratio, threshold, approvals, rejections, votes: [...] };
    },

    // Claim a task
    'x-gitswarm/task/claim': async (params, ctx) => {
      const { task_id } = params;
      // ... optimistic lock claim
      return { claimed: true, task };
    },

    // Batch create streams with dependencies (swarm setup)
    'x-gitswarm/swarm/setup': async (params, ctx) => {
      const { repo_id, streams } = params;
      // ... create streams, set parent_stream_id, create branches
      return { streams: [...created], clone_urls: {...} };
    },
  };
}
```

**REST endpoints stay available as fallback** for the same operations. The MAP methods and REST endpoints share the same underlying service logic — they're two transports into the same business layer.

**Step 4A.6: Dashboard lightweight feed**

The React dashboard does NOT connect via MAP. A thin adapter subscribes to the MAP EventBus and pushes to a simple `/ws/dashboard` endpoint:

```typescript
// Dashboard feed: simple JSON event stream, not MAP protocol
app.get('/ws/dashboard', { websocket: true }, (connection) => {
  const handler = (event) => {
    connection.socket.send(JSON.stringify({
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    }));
  };
  mapServer.eventBus.on('*', handler);
  connection.socket.on('close', () => mapServer.eventBus.off('*', handler));
});
```

**Step 4A.8: Swarm git coordination**

Available as both REST (`POST /api/v1/gitswarm/repos/:id/swarm`) and MAP (`x-gitswarm/swarm/setup`). Accepts pre-decomposed work — GitSwarm does not do task decomposition (D11):

```typescript
// Input: pre-decomposed streams with dependency ordering
{
  "repo_id": "uuid",
  "task_id": "uuid",           // optional: link to gitswarm_task
  "streams": [
    { "agent_id": "uuid-1", "branch": "stream/backend",    "depends_on": [] },
    { "agent_id": "uuid-2", "branch": "stream/api-routes", "depends_on": ["stream/backend"] },
    { "agent_id": "uuid-3", "branch": "stream/tests",      "depends_on": ["stream/api-routes"] }
  ]
}

// GitSwarm:
// 1. Creates gitswarm_streams with parent_stream_id for dependency ordering
// 2. Creates branches in Gitea via GiteaBackend
// 3. Adds agents as Gitea collaborators
// 4. Returns clone URLs per agent
// 5. Emits gitswarm.swarm.created event to repo scope
```

**Exit criteria:**
- Agents connect via MAP SDK, register with API key, auto-join repo scopes
- Agents receive filtered events (per repo, per event type) with reconnection replay
- Agents invoke `x-gitswarm/*` methods for stream/review/merge/consensus/task/swarm operations
- Agent-to-agent messaging works within repo scopes
- Dashboard receives events via separate lightweight feed
- REST API unchanged and functional as fallback
- act_runner enabled in docker-compose, CI results feed into plugin engine

**Dependencies:** Phase 1 complete. `@multi-agent-protocol/sdk` npm package.

### Phase 4B: Cross-System Integration (OpenHive Sync)

**Goal:** Enable OpenHive to make informed coordination decisions based on GitSwarm repo state. Agents are the primary interface (via MAP, Phase 4A). The sync service is a secondary channel for system-to-system state sharing.

**Architectural principle:** MAP is the agent interface. The sync service is for system-level awareness. Agents connect directly to both GitSwarm and OpenHive via MAP — no system-to-system gateway is needed. (See D11, D12.)

**Why no GatewayConnection:** MAP's `GatewayConnection` is designed for federating peer MAP systems (e.g., OpenHive A ↔ OpenHive B) where agents on either side need a unified view. GitSwarm and OpenHive are complementary services, not peers. Agents already hold direct connections to both systems and mediate between them. A system-to-system federation bridge would add coupling, reconnection complexity, and envelope routing overhead with minimal benefit.

**Two integration channels:**
1. **Agents via MAP** (real-time, bidirectional) — agents connect to both systems directly, carry task assignments from OpenHive, execute via GitSwarm
2. **Sync service via REST** (periodic, GitSwarm → OpenHive) — GitSwarm pushes repo state summaries so OpenHive can make informed coordination decisions

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Agent Swarms                                    │
│  (Claude Code teams, custom agents, CI bots)                         │
└──────────┬──────────────────────────────────────┬────────────────────┘
           │ MAP (direct connection)              │ MAP (direct connection)
           │ x-gitswarm/* methods                 │ task assignments, coordination
    ┌──────▼──────────┐                    ┌──────▼──────────┐
    │   GitSwarm      │  REST sync         │   OpenHive      │
    │   (git gov)     │───────────────────►│   (swarm hub)   │
    │                 │  POST /coordination │                 │
    │ MAPServer (4A)  │  /contexts          │ - Discovery     │
    │ Gitea           │                    │ - Task assign   │
    │ Governance      │                    │ - Sessions      │
    └─────────────────┘                    └─────────────────┘
```

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 4B.1 | Federated agent identity mapping table | Small | New: `src/db/migrations/007_external_identities.sql` |
| 4B.2 | OpenHive env config + agent identity resolution on MAP register | Small | `src/config/env.ts`, `src/services/map-server.ts` |
| 4B.3 | Repo state aggregation query | Small | New: `src/services/repo-state.ts` |
| 4B.4 | OpenHive sync service (EventBus subscriber → REST push) | Medium | New: `src/services/openhive-sync.ts` |
| 4B.5 | Optional: startup swarm registration in OpenHive directory | Small | `src/services/openhive-sync.ts` |

**Step 4B.1: Federated agent identity**

When an agent connects to GitSwarm via MAP, it may present an identity from another system. This table links external identities to GitSwarm agent records. Populated when agents register with `metadata.openhive_id`, or when admins link identities via API.

**Step 4B.2: Schema**

```sql
CREATE TABLE IF NOT EXISTS gitswarm_agent_external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  system VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  external_name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, system),
  UNIQUE(system, external_id)
);
```

**Step 4B.3: Repo state aggregation**

Query service (`src/services/repo-state.ts`) that computes per-repo summaries: open stream counts, consensus status, buffer health, active agents, recent merge/stabilization/promotion timestamps. Used by the sync service and also exposed as a REST endpoint.

**Step 4B.4: OpenHive sync service**

Internal service (`src/services/openhive-sync.ts`) that subscribes to GitSwarm's MAP EventBus and pushes repo state to OpenHive via REST (`POST /coordination/contexts`). Triggers on significant events (merge completed, stabilization result, promotion) plus a configurable periodic interval (default 30s).

**What OpenHive receives and uses it for:**
- `buffer_status: "red"` → hold off on assigning new work until CI is green
- `open_streams` counts → distribute work evenly across repos
- `active_agents` → know which agents are already occupied
- Cross-project dependency tracking via merge timestamps

**Step 4B.5: Optional startup swarm registration**

On startup, GitSwarm registers itself in OpenHive's swarm directory (`POST /api/v1/map/swarms`) so agents can discover which GitSwarm serves which repo. Agents on OpenHive then connect directly to GitSwarm via MAP.

**Exit criteria:** Federated agent identities linkable across systems. OpenHive receives periodic repo state summaries from GitSwarm. GitSwarm discoverable in OpenHive's swarm directory. Agents connect directly to both systems via MAP (Phase 4A).

**Dependencies:** Phase 4A complete. OpenHive operational.

### Phase 4C: Unified Platform (future)

**Goal:** Deep integration where GitSwarm, OpenHive, and MAP form a seamless multi-agent development platform.

| Step | Description | Effort |
|------|-------------|--------|
| 4C.1 | self-driving-repo event bridge (GitSwarm events → DAG triggers, outcomes → plugin events) | Medium |
| 4C.2 | act_runner ↔ self-driving-repo wiring (compiled workflows execute on Gitea CI) | Medium |
| 4C.3 | Cross-repo swarm orchestration (one task spanning multiple repos) | Large |
| 4C.4 | Agent capability discovery (OpenHive capabilities → GitSwarm permission enrichment) | Medium |
| 4C.5 | Unified dashboard (GitSwarm React UI shows OpenHive swarm state + MAP topology) | Large |

**Phase 4C is speculative.** Build only when Phases 4A+4B are validated with real users.

**Dependencies:** Phase 4B complete and validated.

### Phase 5: Cloud Readiness

**Goal:** Multi-tenant hosted offering. Only build when demand pulls (D7).

| Step | Description | Effort | Files affected |
|------|-------------|--------|----------------|
| 5.1 | Tenant-aware data model audit (verify all queries scope by `org_id`) | Medium | All query files |
| 5.2 | Gitea-per-tenant orchestration (k8s operator or Fly machines) | Large | New: infra/ |
| 5.3 | API gateway + shared auth (tenant routing, rate limiting) | Large | New: gateway/ |
| 5.4 | Usage metering + billing hooks (per-merge, per-agent-hour) | Medium | New: `src/services/billing.ts` |
| 5.5 | Onboarding flow (sign up → provision tenant → import repos) | Large | New: onboarding routes + UI |

**Dependencies:** Phases 1-3 complete. Phase 4A recommended.

### Phase dependency graph

```
Phase 1: Gitea Foundation
  │
  ├──→ Phase 2: Git-Level Governance
  │
  ├──→ Phase 3: GitHub Compat Facade + Mirroring
  │       │
  │       └──→ Phase 5: Cloud Readiness
  │
  └──→ Phase 4A: MAP-Native Agent Platform
          │       (MAP SDK dependency)
          │
          └──→ Phase 4B: OpenHive Sync
                  │       (REST push, no gateway)
                  │
                  └──→ Phase 4C: SDR + Deep Integration (future)
```

Phases 2, 3, and 4A can proceed in parallel after Phase 1.
Phase 4A requires `@multi-agent-protocol/sdk` as an npm dependency.
Phase 4B requires 4A complete + operational OpenHive instance.
Phase 4C is speculative — only pursue if the composed architecture proves insufficient.
Phase 5 can proceed independently after Phases 1-3.

---

## Appendix A: Gitea API Compatibility Reference

Key Gitea API endpoints that map to GitSwarm operations:

```
# Repos
GET    /api/v1/repos/{owner}/{repo}
POST   /api/v1/orgs/{org}/repos
DELETE /api/v1/repos/{owner}/{repo}

# Branches
GET    /api/v1/repos/{owner}/{repo}/branches
POST   /api/v1/repos/{owner}/{repo}/branches

# File contents
GET    /api/v1/repos/{owner}/{repo}/contents/{path}
PUT    /api/v1/repos/{owner}/{repo}/contents/{path}
POST   /api/v1/repos/{owner}/{repo}/contents/{path}

# Pull requests
GET    /api/v1/repos/{owner}/{repo}/pulls
POST   /api/v1/repos/{owner}/{repo}/pulls
GET    /api/v1/repos/{owner}/{repo}/pulls/{index}
POST   /api/v1/repos/{owner}/{repo}/pulls/{index}/merge
POST   /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews

# Webhooks
GET    /api/v1/repos/{owner}/{repo}/hooks
POST   /api/v1/repos/{owner}/{repo}/hooks

# Users
POST   /api/v1/admin/users
GET    /api/v1/users/{username}
POST   /api/v1/users/{username}/tokens

# Organizations
POST   /api/v1/orgs
GET    /api/v1/orgs/{org}
```

## Appendix B: Event Mapping (GitHub → Gitea → GitSwarm)

| GitHub event | Gitea event | GitSwarm internal event |
|-------------|-------------|------------------------|
| `push` | `push` | `stream.updated` or `repo.pushed` |
| `pull_request.opened` | `pull_request.opened` | `stream.created` |
| `pull_request.closed` | `pull_request.closed` | `stream.abandoned` or `stream.merged` |
| `pull_request_review.submitted` | `pull_request_review.submitted` | `review.submitted` |
| `issues.opened` | `issues.opened` | `task.created` |
| `workflow_run.completed` | (act_runner callback) | `plugin.executed` |
| `installation.created` | N/A | `org.connected` |

## Appendix C: Consensus Flow with Gitea Backend

```
Agent creates stream
  │
  ├── POST /api/v1/gitswarm/repos/:id/streams
  │     └── GitSwarm creates stream record
  │     └── GiteaBackend.createBranch() creates branch in Gitea
  │     └── Agent pushes code to branch via git (SSH/HTTP to Gitea)
  │
  ├── Gitea fires push webhook → GitSwarm records commits
  │
Agent requests review
  │
  ├── POST /api/v1/gitswarm/repos/:id/streams/:sid/reviews
  │     └── Other agents submit verdicts (approve/request_changes)
  │     └── Karma-weighted consensus calculated
  │
Consensus reached
  │
  ├── GitSwarm checks: threshold met? min_reviews met? human approval (if required)?
  │     └── YES → merge to buffer
  │           └── GitSwarm records pending_merge (SHA)
  │           └── GiteaBackend.mergePullRequest() or direct git merge
  │           └── pre-receive hook validates pending_merge
  │           └── Merge succeeds → stabilization triggered
  │     └── NO → stream stays in review
  │
Stabilization
  │
  ├── Run stabilize_command in worktree of buffer branch
  │     └── PASS → promote buffer → main
  │     └── FAIL → revert breaking stream, re-stabilize
```
