# Phase 4A Implementation Plan: MAP-Native Agent Platform

**Status:** Ready for implementation
**Depends on:** Phases 1-3 (complete), `@multi-agent-protocol/sdk` package
**Estimated scope:** 9 steps, ~8 new/modified files

---

## Overview

Phase 4A makes GitSwarm a MAP-native server. Agents connect via the MAP SDK over WebSocket, register with their GitSwarm identity, join repo scopes, and interact through `x-gitswarm/*` extension methods. This replaces the existing `WebSocketService` broadcast with structured, filtered, causally-ordered event delivery.

## Prerequisites

```bash
# Add MAP SDK dependency
npm install @multi-agent-protocol/sdk
```

## Implementation Steps

### Step 1: MAP server service (`src/services/map-server.ts`)

**New file.** Central MAP server instance, agent identity resolution, scope management.

**What it does:**
- Creates a `MAPServer` instance with GitSwarm-specific configuration
- Registers custom `x-gitswarm/*` handlers (from step 5)
- Handles agent registration: resolves API key → GitSwarm UUID, uses UUID as MAP agent ID
- Auto-joins repo scopes on registration (maintainer repos + active stream repos)
- Exports `mapServer` singleton for use across the application

**Key implementation details:**
- Custom `AgentStore` that wraps MAP's in-memory store but enriches with GitSwarm agent data (karma, permissions)
- Agent registration middleware: validates API key in `metadata.api_key`, looks up `agents` table, rejects unknown keys
- Scope creation: on startup, create a MAP scope for each active Gitea-backed repo (`repo:{uuid}`)
- Lazy scope creation: when a new repo is created (Phase 1 flow), also create the MAP scope

**Interfaces with:**
- `src/config/database.ts` (query agents, repos, maintainers, streams)
- `src/middleware/authenticate.ts` (hashApiKey)
- `@multi-agent-protocol/sdk/server` (MAPServer, EventBus, AgentRegistry, ScopeManager)

### Step 2: Replace `/ws` endpoint (`src/index.ts`)

**Modify existing file.** The existing WebSocket endpoint becomes a MAP protocol endpoint.

**Changes:**
- Import `mapServer` from step 1
- Import `websocketStream` from MAP SDK
- Replace the existing `/ws` handler:
  ```typescript
  // Before:
  app.get('/ws', { websocket: true }, (conn) => wsService.addClient(conn.socket));

  // After:
  app.get('/ws', { websocket: true }, (conn) => {
    const router = mapServer.accept(websocketStream(conn.socket), { role: 'agent' });
    router.start();
  });
  ```
- Add separate `/ws/dashboard` endpoint for the React dashboard (step 6)
- Initialize MAP server on startup (create scopes for existing repos)
- Remove `wsService` from service initialization (replaced by `mapServer`)

**What stays the same:**
- All REST routes unchanged
- Redis connection still used (MAP EventBus can use Redis for multi-pod)

### Step 3: Event taxonomy + EventBus integration (`src/services/map-events.ts`)

**New file.** Defines GitSwarm event types and provides helpers for emitting events through MAP's EventBus.

**What it does:**
- Defines typed event constants (GITSWARM_EVENTS enum/object)
- Provides `emitGitSwarmEvent(eventType, data, repoId)` helper that:
  - Constructs a MAP event with proper type, data, and scope (`repo:{repoId}`)
  - Publishes through `mapServer.eventBus.emit()`
- Provides `subscribeToGitSwarmEvents(filter)` helper for internal consumers

**Modify `src/services/activity.ts`:**
- Replace `wsService.publishActivity(event)` calls with `emitGitSwarmEvent()`
- The activity log DB insert stays — MAP events supplement, not replace, the database audit trail

**Modify event emission points across codebase:**
- `src/routes/gitswarm/streams.ts` — `emitGitswarmEvent()` calls → `emitGitSwarmEvent()` (MAP)
- `src/routes/webhooks.ts` — webhook-triggered events → MAP EventBus
- `src/routes/internal/git-hooks.ts` — post-receive events → MAP EventBus
- `src/routes/gitswarm/council.ts` — council events → MAP EventBus

### Step 4: Repo-as-scope model (`src/services/map-server.ts`)

**Part of step 1 file.** Scope lifecycle management.

**Scope creation triggers:**
- Server startup: query all active Gitea-backed repos, create MAP scopes
- `POST /gitswarm/repos` (repo creation): create MAP scope for new repo
- Repo deletion/archival: remove MAP scope

**Auto-join logic (runs on agent MAP registration):**
```sql
-- Repos where agent is maintainer/owner
SELECT repo_id FROM gitswarm_maintainers WHERE agent_id = $1
UNION
-- Repos where agent has active streams
SELECT DISTINCT repo_id FROM gitswarm_streams
WHERE agent_id = $1 AND status IN ('active', 'in_review')
```

**Explicit join/leave:**
- MAP's standard `scopes/join` and `scopes/leave` methods work as-is
- GitSwarm checks repo access permissions before allowing scope join

### Step 5: MAP extension methods (`src/services/map-handlers.ts`)

**New file.** The core agent-facing API over MAP.

**Methods:**

| Method | Params | Returns | DB operations |
|--------|--------|---------|---------------|
| `x-gitswarm/stream/create` | `{ repo_id, branch, base_branch, name }` | `{ stream_id, stream_number, branch }` | INSERT gitswarm_streams, Gitea createBranch |
| `x-gitswarm/stream/review` | `{ stream_id, verdict, feedback }` | `{ consensus: { reached, ratio, ... } }` | INSERT/UPDATE gitswarm_stream_reviews, check consensus |
| `x-gitswarm/stream/merge` | `{ stream_id }` | `{ merged, merge_commit }` or error | Check consensus, INSERT pending_merges + gitswarm_merges, UPDATE stream status |
| `x-gitswarm/consensus/check` | `{ stream_id }` | `{ reached, ratio, threshold, approvals, rejections, votes }` | SELECT reviews, compute consensus |
| `x-gitswarm/task/claim` | `{ task_id }` | `{ claimed, task }` | INSERT gitswarm_task_claims with optimistic lock |
| `x-gitswarm/swarm/setup` | `{ repo_id, task_id?, streams: [...] }` | `{ streams: [...], clone_urls }` | Batch INSERT streams, Gitea createBranch × N |

**Implementation pattern:**
- Each method resolves the agent from `ctx.session` (MAP session → GitSwarm agent)
- Each method checks permissions via `GitSwarmPermissionService`
- Each method emits events via `emitGitSwarmEvent()` after state changes
- Error handling uses MAP's JSON-RPC error codes

**Shared logic with REST:**
- Extract business logic from REST route handlers into shared service functions
- Both REST endpoints and MAP handlers call the same service layer
- Example: `mergeStream(streamId, repoId, agentId)` called by both `PUT /api/v3/pulls/:id/merge` and `x-gitswarm/stream/merge`

### Step 6: Dashboard lightweight feed (`src/index.ts`)

**Modify existing file.** Add a separate WebSocket endpoint for the React dashboard.

```typescript
app.get('/ws/dashboard', { websocket: true }, (conn) => {
  // Subscribe to all MAP events, forward as simple JSON
  const handler = (event) => {
    if (conn.socket.readyState === 1) {
      conn.socket.send(JSON.stringify({
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      }));
    }
  };
  mapServer.eventBus.on('*', handler);
  conn.socket.on('close', () => mapServer.eventBus.off('*', handler));
});
```

The dashboard remains a simple JSON consumer. No MAP SDK needed in the browser.

### Step 7: Consensus state endpoint (REST + MAP)

**Modify `src/routes/gitswarm/streams.ts`.** Add REST endpoint.

```
GET /api/v1/gitswarm/repos/:repoId/streams/:streamId/consensus
→ { reached, ratio, threshold, approvals, rejections, votes: [...] }
```

The MAP equivalent is `x-gitswarm/consensus/check` (step 5). Both call the same `checkConsensusDetailed(streamId, repoId)` service function.

### Step 8: Swarm git coordination (REST + MAP)

**New file `src/routes/gitswarm/swarm.ts`.** REST endpoint for swarm setup.

```
POST /api/v1/gitswarm/repos/:repoId/swarm
{ streams: [{ agent_id, branch, depends_on }, ...] }
→ { streams: [...created], clone_urls: {...} }
```

The MAP equivalent is `x-gitswarm/swarm/setup` (step 5). Both call the same `setupSwarm(repoId, streams)` service function.

**Business logic:**
1. Validate all agent IDs exist and have repo access
2. Create streams with `parent_stream_id` for dependency ordering
3. Create branches in Gitea via `GiteaBackend.createBranch()`
4. Add agents as Gitea collaborators
5. Return stream IDs, stream numbers, and clone URLs
6. Emit `gitswarm.swarm.created` event to repo scope

### Step 9: act_runner CI integration

**Modify `docker-compose.yml`.** Uncomment act_runner service.

**Modify `src/services/plugin-engine.ts`.** Wire act_runner completion events:
- Gitea fires `workflow_run` webhook when act_runner completes
- Webhook handler (already exists) processes the event
- Plugin engine receives the result
- Emit `gitswarm.ci.completed` event with pass/fail status

---

## File Summary

| File | Action | Step |
|------|--------|------|
| `src/services/map-server.ts` | **New** | 1, 4 |
| `src/services/map-events.ts` | **New** | 3 |
| `src/services/map-handlers.ts` | **New** | 5 |
| `src/routes/gitswarm/swarm.ts` | **New** | 8 |
| `src/index.ts` | Modify | 2, 6 |
| `src/services/activity.ts` | Modify | 3 |
| `src/routes/gitswarm/streams.ts` | Modify | 3, 7 |
| `src/routes/gitswarm/index.ts` | Modify | 8 |
| `docker-compose.yml` | Modify | 9 |
| `src/services/plugin-engine.ts` | Modify | 9 |
| `package.json` | Modify | prerequisite (add MAP SDK) |

## Testing Strategy

**Unit tests:**
- `tests/unit/map-server.test.ts` — agent identity resolution, scope auto-join, scope lifecycle
- `tests/unit/map-handlers.test.ts` — each `x-gitswarm/*` method with mocked DB
- `tests/unit/map-events.test.ts` — event type validation, emission helpers

**Integration tests:**
- `tests/integration/gitea-map.test.ts` — full flow: agent connects via MAP, registers, joins scope, creates stream, submits review, checks consensus, merges. Uses real Gitea + PostgreSQL containers + MAP's `createStreamPair()` for in-process MAP connections.

## Migration Notes

- The existing `/ws` endpoint changes protocol (raw JSON → MAP JSON-RPC). Any existing WebSocket clients need to switch to the MAP SDK or use the new `/ws/dashboard` endpoint.
- The `WebSocketService` class in `src/services/websocket.ts` becomes unused and can be removed after migration.
- All existing REST API endpoints remain fully functional — MAP is an additional interface, not a replacement for HTTP.

## Order of Implementation

1. **Steps 1-2** first: MAP server + endpoint replacement. At this point agents can connect but only use standard MAP features (subscribe, messages).
2. **Step 3**: Wire events. Now agents receive GitSwarm events.
3. **Step 4**: Scope model. Now events are filtered per-repo.
4. **Step 5**: Extension methods. Now agents can do everything over MAP.
5. **Steps 6-7**: Dashboard feed + consensus endpoint. Polish.
6. **Step 8**: Swarm coordination.
7. **Step 9**: act_runner. Can be done in parallel with 5-8.
