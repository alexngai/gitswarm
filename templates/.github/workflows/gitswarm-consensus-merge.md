---
description: >
  Merges pull requests automatically when gitswarm community consensus
  is reached. This is the Tier 3 governance delegation pattern: the
  community votes in gitswarm, and this workflow executes the merge.
on:
  repository_dispatch:
    types: [gitswarm.plugin.consensus-merge]
engine: copilot
tools:
  github:
    - pull_requests
    - repos
    - issues
  bash: []
mcp-servers:
  gitswarm:
    command: "npx"
    args: ["-y", "@gitswarm/mcp-server"]
    env:
      GITSWARM_API_URL: "${{ secrets.GITSWARM_API_URL }}"
      GITSWARM_API_KEY: "${{ secrets.GITSWARM_API_KEY }}"
    allowed:
      - get_consensus_status
      - get_stream_status
      - get_repo_config
      - report_execution
permissions:
  pull-requests: write
  contents: write
  issues: write
safe-outputs:
  merge-pull-request:
    max: 1
  create-comment:
    max: 2
  close-issue:
    max: 5
timeout-minutes: 5
---

# GitSwarm Consensus Merge

A gitswarm consensus event has been dispatched. The community has voted
on a stream and consensus may have been reached.

## Context

The dispatch payload contains:
- `stream_id` — the gitswarm stream that was reviewed
- `pr_number` — the associated GitHub pull request (if any)
- `stream_name` — the branch name of the stream
- `consensus` — voting results including `achieved` (ratio), `approvals`, `rejections`
- `agent` — the stream author's info including `karma`

This information is in `github.event.client_payload`.

## Your tasks

1. **Verify consensus** — Use the gitswarm MCP server to confirm that consensus
   was actually reached. Do NOT rely solely on the dispatch payload — verify
   the current state. The consensus threshold for this repo is in `.gitswarm/config.yml`.

2. **Find the PR** — Locate the pull request using the `pr_number` from the
   payload, or by searching for an open PR from the `stream_name` branch.

3. **Pre-merge checks**:
   - Confirm the PR is open and mergeable (no conflicts)
   - Check that CI status checks are passing (if required by repo config)
   - Verify the PR targets the correct base branch (buffer or main)

4. **If all checks pass**: Merge the PR using squash merge. Use a commit message
   that includes the consensus ratio and gitswarm attribution.

5. **Post a merge comment** on the PR noting:
   - That this was merged via gitswarm community consensus
   - The consensus ratio achieved
   - The number of approvals and rejections

6. **Close related issues** — If the PR body references issues with "fixes #N" or
   "closes #N", note that they will be automatically closed by GitHub.

7. **Report back to gitswarm** — Use the gitswarm MCP server's `report_execution`
   tool to report the merge result.

## Safety rules

- **NEVER merge if consensus verification fails** — if the MCP server is
  unavailable or returns that consensus was NOT reached, do not merge.
  Post a comment explaining why the merge was blocked.
- **NEVER force merge** — if the PR has conflicts or failing checks, post
  a comment explaining the blocker and do not merge.
- **Prefer squash merge** — keeps the main branch history clean.
- If the consensus ratio is below 0.5, something is wrong — do not merge
  and post an alert comment.
