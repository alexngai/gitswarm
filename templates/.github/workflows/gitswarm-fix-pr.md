---
description: >
  Slash command: /fix — analyzes CI failures on a PR and attempts
  to fix them automatically. Triggered by commenting /fix on a PR.
on:
  issue_comment:
    types: [created]
    skip-if-no-match: "is:pr /fix"
engine: copilot
tools:
  github:
    - pull_requests
    - repos
    - actions
  bash:
    - "npm"
    - "npx"
    - "node"
    - "git"
    - "make"
  edit: []
mcp-servers:
  gitswarm:
    command: "npx"
    args: ["-y", "@gitswarm/mcp-server"]
    env:
      GITSWARM_API_URL: "${{ secrets.GITSWARM_API_URL }}"
      GITSWARM_API_KEY: "${{ secrets.GITSWARM_API_KEY }}"
    allowed:
      - get_repo_config
      - get_stream_status
permissions:
  pull-requests: write
  contents: write
  actions: read
safe-outputs:
  push-to-branch:
    max: 1
  create-comment:
    max: 2
timeout-minutes: 15
---

# GitSwarm PR Fix

Someone commented `/fix` on a pull request. Your job is to analyze the
CI failures and attempt to fix them.

## Your tasks

1. **Identify the PR** from the comment context.

2. **Check CI status** — find the failing checks/workflow runs.
   Download the logs to understand what's failing.

3. **Analyze the failures**:
   - Is it a test failure? Read the failing test and the code it tests.
   - Is it a lint/format error? Check the linting configuration.
   - Is it a build error? Check for missing imports, type errors, etc.
   - Is it a dependency issue? Check package.json/lock file.

4. **Attempt a fix**:
   - Checkout the PR branch
   - Make the minimum changes needed to fix the CI failure
   - Run the failing tests/checks locally to verify your fix
   - Push the fix to the PR branch

5. **Post a comment** explaining:
   - What was failing and why
   - What you changed to fix it
   - Whether local verification passed

## Safety rules

- Only push to the PR's head branch — never to main, buffer, or other branches
- Make minimal changes — fix the CI failure, don't refactor or improve
- If you can't identify a clear fix, post a comment with your analysis
  instead of pushing speculative changes
- Don't modify `.github/workflows/` or `.gitswarm/` files
- If there are multiple failures, fix them incrementally and verify each
