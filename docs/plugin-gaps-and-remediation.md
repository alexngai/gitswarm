# Plugin System: Gap Analysis & Remediation Strategy

## Architectural Principle

The gitswarm plugin system has two independent planes that interoperate:

1. **Repo-side plane** (GitHub Actions): Workflows fire autonomously on GitHub events. They use AI agent actions (claude-code-action, codex-action) and optionally connect to gitswarm via the MCP server for context. This plane works **without** the gitswarm server.

2. **Server-side plane** (plugin engine): Receives webhook events, tracks plugin state, enforces rate limits, records audit logs, and dispatches gitswarm-only events (consensus, council) that GitHub doesn't know about. This is an **optional federation layer**.

The two planes interoperate: the server observes what workflows do (via webhook echoes and execution reports), and dispatches events that only the server can produce. Neither plane depends on the other to function.

---

## Gap 1: Dual Plugin Registration Causes Double Execution

### Problem

`plugins.yml` and workflow file detection register the same logical plugin under different names with different execution models:

| Source | Name | Model | Trigger |
|--------|------|-------|---------|
| `plugins.yml` | `issue-enrichment` | `dispatch` | `issues.opened` |
| Workflow detection | `gitswarm-issue-triage` | `workflow` | `issues.opened` |

Both match `issues.opened`. The `dispatch` plugin fires a `repository_dispatch`, causing the workflow to run a second time (once natively from GitHub, once from the dispatch). This doubles AI cost and creates duplicate comments/labels.

### Remediation

**Split plugin roles clearly between the two planes.**

Config-sourced plugins (`plugins.yml`) define the **server-side policy**: rate limits, conditions, safe output budgets, and audit expectations. They should NOT dispatch for triggers that already have a corresponding workflow file — the workflow handles execution independently.

Workflow-sourced plugins (detected `.yml` files) represent the **repo-side execution**. The server registers them for visibility only.

Implementation:

1. **Add a `workflow_file` field to `gitswarm_repo_plugins`** that links a config-sourced plugin to its corresponding workflow file. Config sync populates this by matching `dispatch_target` event types against workflow `repository_dispatch` types and by matching trigger events against workflow native triggers.

2. **In `_syncPlugins`, when a config plugin has a matching workflow file**: set `execution_model = 'workflow'` instead of `'dispatch'`. This tells the plugin engine that the workflow fires natively — no dispatch needed for native triggers.

3. **In `_detectWorkflowTemplates`, skip registration if a config-sourced plugin already covers this trigger.** Instead, update the existing config plugin's `workflow_file` field. This eliminates the duplicate registration.

4. **In the plugin engine, for `workflow` model plugins on native triggers**: record audit only (`workflow_native`), do not dispatch. For gitswarm-only triggers: dispatch as before.

```
Config sync reconciliation logic:

For each workflow file gitswarm-*.yml:
  Parse trigger events
  For each config plugin with matching trigger:
    Link: plugin.workflow_file = workflow filename
    Set: plugin.execution_model = 'workflow'
  If no matching config plugin:
    Register as workflow-only plugin (source='workflow')
```

### Migration

```sql
ALTER TABLE gitswarm_repo_plugins
  ADD COLUMN IF NOT EXISTS workflow_file VARCHAR(255);

-- Comment update for execution_model and source
-- execution_model: 'builtin' | 'dispatch' | 'workflow' | 'webhook'
-- source: 'config' | 'api' | 'workflow' | 'catalog'
```

---

## Gap 2: No Trigger Source for Gitswarm Events (Tier 3 Dead)

### Problem

`processGitswarmEvent(repoId, eventType, payload)` exists in the plugin engine but **nothing in the codebase calls it**. The consensus system (`permissionService.checkConsensus`), stream lifecycle, and stabilization checks never emit events to the plugin engine. This means:

- `consensus-merge` plugin: never triggered
- `auto-promote` plugin: never triggered
- `karma-fast-track` plugin: never triggered
- Any Tier 3 governance delegation: impossible

### Remediation

**Add gitswarm event emission at each lifecycle point.** The plugin engine should be called at:

| Event | Source Location | Description |
|-------|----------------|-------------|
| `consensus_reached` | After `permissionService.checkConsensus` returns positive in review handler | Consensus threshold met for a stream |
| `consensus_blocked` | Same location, negative result | Consensus explicitly rejected |
| `stabilization_passed` | After `stabilize_command` succeeds (buffer promotion logic) | Buffer branch CI is green |
| `stabilization_failed` | After `stabilize_command` fails | Buffer branch CI is red |
| `stream_submitted` | When a new stream/PR is opened via gitswarm | New contribution submitted |
| `stream_merged` | After a stream is merged into buffer/main | Contribution accepted |
| `council_proposal_created` | When a governance proposal is created | New council vote initiated |
| `council_proposal_resolved` | When a governance proposal passes/fails | Council decision made |

Implementation — add calls at each point:

```javascript
// In the review/consensus handler (webhooks.js or consensus service):
if (consensusResult.achieved) {
  pluginEngine.processGitswarmEvent(repoId, 'consensus_reached', {
    stream_id: streamId,
    pr_number: prNumber,
    stream_name: branchName,
    consensus: {
      achieved: consensusResult.ratio,
      approvals: consensusResult.approvals,
      rejections: consensusResult.rejections,
    },
    agent: { id: agentId, karma: agentKarma },
  }).catch(err => console.error('Plugin event failed:', err));
}
```

Each emission is fire-and-forget (non-blocking), matching the existing webhook→plugin pattern.

### Scope

This requires identifying the exact code locations for consensus checks, buffer promotion, and stream lifecycle events. These are in:
- `src/routes/webhooks.js` — PR review handling
- `src/routes/gitswarm/index.js` — stream management, consensus evaluation
- Buffer promotion logic (wherever `auto_promote_on_green` is checked)

---

## Gap 3: MCP Server Not Distributable

### Problem

`@gitswarm/mcp-server` is a local package in `src/mcp-server/` but is not published to npm. The `.mcp.json` template specifies `npx -y @gitswarm/mcp-server` which would fail in any GitHub Actions environment.

Without the MCP server, AI agents in workflows have no access to gitswarm data (consensus status, karma, streams, repo config). They can still operate on GitHub data but lose all gitswarm context.

### Remediation

Three options, in order of increasing effort:

**Option A (Immediate): Vendor as a GitHub Action**

Create a composite GitHub Action that bundles the MCP server. Workflows reference it as a local action or published action instead of `npx`.

```yaml
# .github/actions/gitswarm-mcp/action.yml
name: GitSwarm MCP Server
description: Starts the gitswarm MCP server for AI agent workflows
inputs:
  api_url:
    required: true
  api_key:
    required: true
  repo_id:
    required: true
runs:
  using: node20
  main: index.js
```

Workflows then reference `uses: ./.github/actions/gitswarm-mcp` or `uses: alexngai/gitswarm-mcp-action@v1`.

**Option B (Short-term): Publish to npm**

Publish `@gitswarm/mcp-server` to npm so `npx` works. Requires npm account, CI/CD for publishing, and versioning strategy.

**Option C (Long-term): Both A and B**

Publish to npm for general use, and vendor as a GitHub Action for workflows that don't want npm dependencies.

### Recommendation

Start with **Option A** — it's the fastest path to a working end-to-end flow. The `.mcp.json` template would change to reference the vendored action path, and the workflow templates would add a setup step.

However, the simpler fix for `.mcp.json` is to make the MCP server available via a git-based npx invocation:

```json
{
  "mcpServers": {
    "gitswarm": {
      "command": "npx",
      "args": ["-y", "github:alexngai/gitswarm-mcp-server"],
      "env": {
        "GITSWARM_API_URL": "",
        "GITSWARM_API_KEY": "",
        "GITSWARM_REPO_ID": ""
      }
    }
  }
}
```

This requires splitting the MCP server into its own repo with a `package.json` that has a `bin` field.

---

## Gap 4: Safe Outputs Not Enforced for AI Workflows

### Problem

For `builtin` plugins, the server enforces safe output budgets programmatically (check before each action, record consumption). For `dispatch`/`workflow` plugins, safe outputs are only stated in the AI prompt ("maximum 3 labels, 1 comment"). Claude Code Action has full `issues: write` permission — nothing prevents the AI from exceeding limits.

This is the correct tradeoff for now (the server can't intercept GitHub API calls made by a workflow running in the repo's Actions environment), but there's no post-hoc verification either.

### Remediation

**Add post-execution audit checking.** The server can't prevent over-budget actions in real-time, but it can detect them after the fact and take corrective action.

Implementation:

1. **Add a webhook listener for workflow-generated actions.** When the plugin engine receives follow-up webhooks (issue labeled, comment created, PR merged) within the execution window of a known dispatched plugin, attribute them to that execution and count against the budget.

2. **Store expected safe outputs per execution.** When an execution is created (dispatched or workflow_native), record the expected budget in `gitswarm_plugin_executions.safe_output_usage` as the starting budget.

3. **Add a `_auditWorkflowActions` method** to the plugin engine that, on receiving webhook events, checks if they were produced by a recently-dispatched plugin (by timestamp + repo + action type correlation) and updates the execution record's `actions_taken`.

4. **Alert on over-budget.** If post-hoc audit detects a workflow exceeded its budget, log an activity event and optionally disable the plugin or add a warning label/comment.

```javascript
// Correlation logic in plugin engine:
async _correlateWebhookToExecution(repoId, actionType, payload) {
  // Find recent executions (last 10 minutes) for this repo
  // that have matching safe_output budgets for this action type
  const recent = await this.db.query(`
    SELECT id, plugin_id, safe_output_usage FROM gitswarm_plugin_executions
    WHERE repo_id = $1 AND status IN ('dispatched', 'running')
      AND started_at > NOW() - INTERVAL '10 minutes'
    ORDER BY started_at DESC
  `, [repoId]);

  // Attribute action to most recent matching execution
  // Update actions_taken and check against budget
}
```

### Scope

This is an enhancement, not a blocker. The prompt-based approach works for well-behaved AI models. Post-hoc audit adds a safety net.

---

## Gap 5: Execution Reporting Incomplete

### Problem

Only `consensus-merge` workflow instructs the AI to call `report_execution`. The other 4 workflows never report back, so execution records stay in `dispatched` status permanently.

### Remediation

**Two-pronged approach:**

1. **Add `report_execution` instructions to all workflow prompts.** Each workflow should end with: "Report your results to gitswarm using the MCP server's `report_execution` tool."

2. **Add execution timeout cleanup.** A periodic job (or on next webhook for the same repo) marks stale `dispatched` executions as `timed_out` after a configurable period (e.g., 30 minutes).

3. **Use GitHub Actions webhook events for passive completion tracking.** The `workflow_run` webhook fires when a GitHub Actions workflow completes. The plugin engine can listen for `workflow_run.completed` events and match them to dispatched executions by workflow filename and timing.

```javascript
// In webhook handler, add case for workflow_run:
case 'workflow_run':
  if (payload.action === 'completed' && payload.workflow_run) {
    const workflowName = payload.workflow_run.name;
    const conclusion = payload.workflow_run.conclusion; // 'success' | 'failure'
    // Match to dispatched executions by repo + workflow name + timing
    await pluginEngine.resolveWorkflowCompletion(repoId, workflowName, conclusion);
  }
  break;
```

Implementation for `resolveWorkflowCompletion`:

```javascript
async resolveWorkflowCompletion(repoId, workflowName, conclusion) {
  // Find the most recent dispatched execution whose plugin's
  // dispatch_target matches this workflow filename
  const result = await this.db.query(`
    UPDATE gitswarm_plugin_executions SET
      status = CASE WHEN $3 = 'success' THEN 'completed' ELSE 'failed' END,
      completed_at = NOW()
    WHERE id = (
      SELECT e.id FROM gitswarm_plugin_executions e
      JOIN gitswarm_repo_plugins p ON e.plugin_id = p.id
      WHERE e.repo_id = $1 AND e.status = 'dispatched'
        AND p.dispatch_target LIKE $2
        AND e.started_at > NOW() - INTERVAL '30 minutes'
      ORDER BY e.started_at DESC LIMIT 1
    )
    RETURNING id
  `, [repoId, `%${workflowName}%`, conclusion]);

  return result.rows[0]?.id;
}
```

---

## Gap 6: Builtin Actions Are Stubs

### Problem

Several builtin actions are no-ops or produce incorrect results:

| Action | Problem |
|--------|---------|
| `promote_buffer_to_main` | Returns `{ status: 'requires_dispatch' }`, does nothing |
| `notify_contributors` | Returns `{ status: 'dispatched' }`, dispatches nothing |
| `_resolveLabels` | Returns first 3 `allowed_labels` regardless of context |
| `notify_stream_owner` | Not implemented at all |

### Remediation

**`promote_buffer_to_main`**: This is a Tier 1 deterministic action. Implement it using the existing git-cascade integration:

```javascript
case 'promote_buffer_to_main':
case 'promote': {
  const config = await this._getRepoConfig(repoId);
  const bufferBranch = config.buffer_branch || 'buffer';
  const target = config.promote_target || 'main';

  // Use GitHub API to create a merge (fast-forward if possible)
  await this._mergeBranch(repoId, bufferBranch, target);
  this.safeOutputs.recordAction(context, 'promote_buffer_to_main');
  actionsTaken.push({ action: 'promote_buffer_to_main', from: bufferBranch, to: target });
  break;
}
```

**`notify_contributors`**: Post a comment or create a notification via GitHub API:

```javascript
case 'notify_contributors': {
  const message = typeof action === 'object' ? action.message : 'A gitswarm event occurred.';
  // Get contributors for the relevant PR/issue
  // Post a comment mentioning them
  break;
}
```

**`_resolveLabels`**: The builtin `add_labels` action for Tier 1 plugins is deterministic — it applies labels from the plugin config, not from AI analysis. The current behavior (apply configured allowed_labels) is correct for Tier 1 but the limit should match `max_label_additions` from safe_outputs, not a hardcoded 3:

```javascript
_resolveLabels(plugin, payload) {
  const allowedLabels = plugin.safe_outputs?.allowed_labels || [];
  const maxLabels = plugin.safe_outputs?.max_label_additions || 3;
  return allowedLabels.slice(0, maxLabels);
}
```

For Tier 2, label application is handled by the AI in the workflow, not by the builtin executor.

**`notify_stream_owner`**: Implement for stale-stream-cleanup:

```javascript
case 'notify_stream_owner': {
  // Look up the stream owner from gitswarm
  // Post a comment on their PR or create an issue
  break;
}
```

### Priority

`promote_buffer_to_main` is the highest priority since it blocks the auto-promote plugin (Tier 1 core functionality). `_resolveLabels` fix is trivial. The notification actions are lower priority since they're UX polish.

---

## Gap 7: Condition Evaluation Is Shallow

### Problem

`plugins.yml` uses rich conditions:
- `files_match: ["docs/**"]` — glob matching against changed files
- `stream_inactive_days: 14` — computed from last activity timestamp
- `agent_karma: ">= 5000"` — requires querying gitswarm data
- `consensus_threshold_met: true` — requires querying consensus state
- `stabilization: green` — requires querying CI status

But `_evaluateConditions` only does simple key/value/comparison against the raw webhook payload. It has no glob matching, no gitswarm API calls, no computed conditions.

### Remediation

**Add condition evaluators for gitswarm-specific conditions.** Make `_evaluateConditions` async and add specialized evaluators:

```javascript
async _evaluateConditions(plugin, conditions, payload) {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  for (const [key, expected] of Object.entries(conditions)) {
    let result;

    switch (key) {
      case 'files_match':
        result = this._evaluateFilesMatch(expected, payload);
        break;
      case 'consensus_threshold_met':
        result = await this._evaluateConsensus(plugin.repo_id, payload);
        break;
      case 'agent_karma':
        result = await this._evaluateKarma(plugin.repo_id, payload, expected);
        break;
      case 'stream_inactive_days':
        result = this._evaluateInactivity(payload, expected);
        break;
      case 'stabilization':
        result = await this._evaluateStabilization(plugin.repo_id, expected);
        break;
      case 'max_files_changed':
        result = this._evaluateFileCount(payload, expected);
        break;
      default:
        result = this._evaluateSimpleCondition(payload, key, expected);
    }

    if (!result) return false;
  }
  return true;
}

_evaluateFilesMatch(patterns, payload) {
  const files = payload.pull_request?.changed_files_list
    || payload.commits?.flatMap(c => [...(c.added || []), ...(c.modified || [])])
    || [];

  // Use minimatch or picomatch for glob matching
  return files.some(file =>
    patterns.some(pattern => minimatch(file, pattern))
  );
}
```

### Scope

This is a medium-effort improvement. The simple comparisons work for basic conditions. Glob matching and karma evaluation would unlock the karma-fast-track and file-based conditions.

---

## Gap 8: Report Endpoint Authentication

### Problem

The `POST /repos/:id/plugins/executions/:execId/report` endpoint uses the `authenticate` middleware, which expects a Bearer token from a registered agent. GitHub Actions workflows have `GITSWARM_API_KEY` in secrets, but it's unclear what kind of token this is or how workflows authenticate.

If it's an agent token, it requires a registered agent identity. If it's an API key, the authenticate middleware may not accept it.

### Remediation

**Add a plugin execution token.** When the plugin engine dispatches an execution, include a short-lived token in the dispatch payload:

```javascript
// In _dispatchToGitHubActions:
const executionToken = crypto.randomBytes(32).toString('hex');
const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min

await this.db.query(`
  UPDATE gitswarm_plugin_executions
  SET dispatch_token_hash = $2, dispatch_token_expires_at = $3
  WHERE id = $1
`, [executionId, hashToken(executionToken), tokenExpiry]);

const clientPayload = {
  gitswarm: {
    execution_id: executionId,
    execution_token: executionToken, // workflow uses this to report back
    ...
  },
};
```

Then add a separate auth path for the report endpoint that accepts execution tokens:

```javascript
// In plugins.js report route:
async function authenticateExecution(request, reply) {
  const token = request.headers['x-gitswarm-execution-token'];
  if (token) {
    const exec = await db.query(`
      SELECT id FROM gitswarm_plugin_executions
      WHERE id = $1 AND dispatch_token_hash = $2
        AND dispatch_token_expires_at > NOW()
    `, [request.params.execId, hashToken(token)]);

    if (exec.rows.length > 0) return; // authenticated
  }
  // Fall back to normal Bearer auth
  return authenticate(request, reply);
}
```

### Migration

```sql
ALTER TABLE gitswarm_plugin_executions
  ADD COLUMN IF NOT EXISTS dispatch_token_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS dispatch_token_expires_at TIMESTAMPTZ;
```

---

## Gap 9: No Startup Sync

### Problem

When the server restarts, plugin registrations depend on whatever was last synced to the database. If the server was down when a `.gitswarm/` file was pushed, the database is stale. There's no catch-up mechanism.

### Remediation

**Add an optional startup sync.** On server boot, for all active repos with `plugins_enabled = true`, queue a config sync:

```javascript
// In src/index.js, after server starts:
async function startupSync(db, configSyncService) {
  const repos = await db.query(`
    SELECT id FROM gitswarm_repos
    WHERE status = 'active' AND plugins_enabled = true
  `);

  for (const repo of repos.rows) {
    configSyncService.syncRepoConfig(repo.id)
      .catch(err => console.error(`Startup sync failed for ${repo.id}:`, err.message));
  }
}

// Call after app.listen():
startupSync(db, configSyncService);
```

Rate-limit this to avoid hitting GitHub API limits on startup for orgs with many repos. Process in batches with delay.

---

## Gap 10: Safe Output Key Mismatches

### Problem

`plugins.yml` uses `max_prs: 1` but `safe-outputs.js` maps to `max_pr_creates`. `plugins.yml` uses `max_merges: 1` but the action cost map uses `merge_to_buffer` → `max_merges`. Some keys match, some don't, and unknown keys are silently allowed.

### Remediation

**Normalize safe output key names** and add validation:

1. Update `ACTION_COST_MAP` to cover all keys used in `plugins.yml`:

```javascript
const ACTION_COST_MAP = {
  'add_labels':           { budget: 'max_label_additions', cost: 1 },
  'add_label':            { budget: 'max_label_additions', cost: 1 },
  'add_comment':          { budget: 'max_comments', cost: 1 },
  'post_summary':         { budget: 'max_comments', cost: 1 },
  'create_pr':            { budget: 'max_prs', cost: 1 },
  'create_github_pr':     { budget: 'max_prs', cost: 1 },
  'merge_to_buffer':      { budget: 'max_merges', cost: 1 },
  'merge_stream_to_buffer': { budget: 'max_merges', cost: 1 },
  'promote_buffer_to_main': { budget: 'max_merges', cost: 1 },
  'close_issue':          { budget: 'max_issue_closures', cost: 1 },
  'close_completed_tasks': { budget: 'max_issue_closures', cost: 1 },
  'auto_approve_review':  { budget: 'max_approvals', cost: 1 },
};
```

2. Log warnings for unknown actions instead of silently allowing them:

```javascript
checkAction(context, actionName) {
  const mapping = ACTION_COST_MAP[actionName];
  if (!mapping) {
    console.warn(`Safe outputs: unknown action "${actionName}", allowing by default`);
    return { allowed: true };
  }
  // ... existing logic with corrected key names
}
```

---

## Gap 11: Basic YAML Parser Cannot Handle Arrays

### Problem

The fallback `_basicYamlParse` in config-sync.js cannot parse YAML arrays (lines starting with `-`). If `js-yaml` is not available, `plugins.yml` would parse incorrectly — `actions`, `allowed_labels`, and other list fields would be empty or malformed.

### Remediation

**Make `js-yaml` a required dependency, not optional.** Add it to `package.json` dependencies. The fallback parser is a fragility risk — it's better to fail explicitly than produce incorrect configs silently.

```json
// package.json
{
  "dependencies": {
    "js-yaml": "^4.1.0"
  }
}
```

Remove the basic YAML parser and replace with a clear error if `js-yaml` is unavailable:

```javascript
_parseYaml(content) {
  if (!yaml?.load) {
    throw new Error('js-yaml is required for config sync. Install with: npm install js-yaml');
  }
  return yaml.load(content);
}
```

---

## Gap 12: MCP Server Has Stale gh-aw References

### Problem

`src/mcp-server/index.js` header comments reference "gh-aw workflows" and "gh-aw frontmatter" from the previous architecture.

### Remediation

Update comments to reference standard GitHub Actions workflows. This is a trivial documentation fix.

---

## Gap 13: Double Execution Record for Dispatch Model

### Problem

In `_dispatchToGitHubActions`, an execution record is INSERT-ed with status `'dispatched'` before the actual dispatch (line 303). Then in `_executePlugin`, `_recordExecution` is called again after dispatch completes (line 162), creating a second record. This produces duplicate audit entries per dispatch.

### Remediation

**Skip `_recordExecution` in `_executePlugin` when the execution model already created its own record.** The dispatch and workflow methods create records with specific `dispatch_id` tracking — the generic `_recordExecution` at the end is redundant for these models.

```javascript
// In _executePlugin, after the switch:
const modelsWithOwnRecords = ['dispatch', 'workflow'];
if (!modelsWithOwnRecords.includes(plugin.execution_model)) {
  await this._recordExecution(plugin, trigger, payload, result.status, result.actionsTaken || [], summary);
}
```

---

## Gap 14: Rate Limit Table Grows Unboundedly

### Problem

`gitswarm_plugin_rate_limits` gets one row per plugin per hour per day, with no cleanup. Over time this accumulates stale data.

### Remediation

Add a periodic cleanup query (run daily or on each rate limit check):

```sql
DELETE FROM gitswarm_plugin_rate_limits
WHERE window_start < NOW() - INTERVAL '7 days';
```

Run this in the rate limit check method or as a scheduled task.

---

## Implementation Priority

### Phase 2a: Critical Path (make end-to-end work)

| # | Gap | Effort | Impact |
|---|-----|--------|--------|
| 1 | Dual plugin registration fix | Medium | Prevents double execution, double cost |
| 2 | Gitswarm event emission | Medium | Unblocks all Tier 3 governance |
| 3 | MCP server distribution | Low | Enables gitswarm context in workflows |
| 5 | Execution reporting (workflow_run) | Low | Completes audit trail |
| 13 | Double execution record fix | Low | Fixes audit log accuracy |

### Phase 2b: Correctness (make it reliable)

| # | Gap | Effort | Impact |
|---|-----|--------|--------|
| 6 | Implement builtin stubs | Medium | Enables auto-promote (Tier 1 core) |
| 8 | Report endpoint auth | Medium | Secure execution reporting |
| 10 | Safe output key normalization | Low | Fixes silent enforcement failures |
| 11 | Require js-yaml | Low | Prevents config parsing failures |
| 9 | Startup sync | Low | Resilience after restarts |
| 14 | Rate limit cleanup | Low | Prevents table bloat |

### Phase 2c: Robustness (make it safe)

| # | Gap | Effort | Impact |
|---|-----|--------|--------|
| 4 | Post-hoc safe output audit | High | Detects AI over-budget actions |
| 7 | Rich condition evaluation | High | Enables karma-fast-track, file glob conditions |
| 12 | Stale comments cleanup | Low | Documentation accuracy |

---

## Architectural Decisions to Codify

1. **Workflows are autonomous.** The server never prevents a workflow from running. It observes, audits, and rate-limits future dispatches based on past behavior.

2. **The server dispatches only what GitHub can't.** Native GitHub events (issues, PRs, comments, schedule) trigger workflows directly. The server dispatches only gitswarm-originated events (consensus, council, stabilization).

3. **plugins.yml is policy, workflows are execution.** `plugins.yml` declares what a plugin should do, its limits, and conditions. The workflow `.yml` file implements the execution. Config sync links them.

4. **MCP is the interop bridge.** The MCP server is the only runtime dependency between planes. If it's unavailable, workflows still function (with GitHub data only), and the server still tracks (without workflow feedback).

5. **Execution tokens replace shared API keys.** Each dispatched execution gets a short-lived token for reporting back, rather than using a long-lived API key that has broader permissions.
