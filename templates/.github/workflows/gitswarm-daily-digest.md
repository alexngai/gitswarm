---
description: >
  Daily summary of gitswarm activity across the repository.
  Reports on streams, consensus votes, new contributors, and
  overall project health.
on:
  schedule:
    - cron: "0 9 * * 1-5"   # weekdays at 9am UTC
engine: copilot
tools:
  github:
    - issues
    - pull_requests
    - repos
  bash: []
mcp-servers:
  gitswarm:
    command: "npx"
    args: ["-y", "@gitswarm/mcp-server"]
    env:
      GITSWARM_API_URL: "${{ secrets.GITSWARM_API_URL }}"
      GITSWARM_API_KEY: "${{ secrets.GITSWARM_API_KEY }}"
    allowed:
      - get_repo_activity
      - get_stream_status
      - get_repo_config
      - get_stage_info
      - list_active_streams
permissions:
  issues: write
  contents: read
safe-outputs:
  create-issue:
    max: 1
timeout-minutes: 10
---

# GitSwarm Daily Digest

Generate a daily status report for this gitswarm-managed repository.

## Your tasks

1. **Gather activity data** from the last 24 hours using both GitHub and
   gitswarm MCP:
   - New issues opened
   - PRs opened, merged, and closed
   - New commits pushed
   - Active gitswarm streams and their status
   - Consensus votes completed
   - New contributors (first-time PRs or stream submissions)

2. **Check project health**:
   - Are any streams stale (no activity in 7+ days)?
   - Are any PRs blocked on failing CI?
   - Is the buffer branch ahead of main (pending promotion)?
   - Current repo stage (seed/growth/established/mature)

3. **Create an issue** with the daily digest:
   - Title: `Daily Digest — [date]`
   - Organized sections for each area
   - Highlight anything that needs attention (stale streams, blocked PRs)
   - Include contributor stats and karma changes if available

## Formatting

Use clear markdown with tables where appropriate. Keep the digest
concise — aim for a quick scan in under 2 minutes. If there was no
meaningful activity, create a brief "quiet day" summary instead of
skipping the digest entirely.

Close the previous day's digest issue if one exists (search for issues
with the "daily-digest" label).
