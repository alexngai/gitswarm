# gitswarm-cli

Standalone CLI for local multi-agent federation coordination.

Extracts the coordination primitives from the BotHub/GitSwarm web platform into a portable tool that runs locally against any git repository. No PostgreSQL, Redis, or GitHub App required — just SQLite.

## When to use what

| Scenario | Tool |
|---|---|
| Local sandboxed repo, agents on one machine | **gitswarm-cli** |
| Agents across machines / orgs, human dashboard | Full web app (`src/`) |
| Embedding federation in your own agent framework | `import { Federation } from 'gitswarm-cli'` |

## Install

```bash
cd cli && npm install
npm link          # makes `gitswarm` available globally
```

## Quick start

```bash
# Initialise federation in any git repo
cd my-project
gitswarm init --name my-project --model guild

# Register agents
gitswarm agent register architect --desc "System design agent"
gitswarm agent register coder     --desc "Implementation agent"
gitswarm agent register reviewer  --desc "Code review agent"

# Create and distribute tasks
gitswarm task create "Implement auth module" --priority high --as architect
gitswarm task claim a1b2c3d4 --as coder
gitswarm task submit <claim-id> --as coder --notes "Done with JWT"
gitswarm task review <claim-id> approve --as architect

# Patch review with consensus
gitswarm patch create "Add auth middleware" --as coder --branch feature/auth
gitswarm review submit <patch-id> approve --as reviewer --feedback "LGTM"
gitswarm review check <patch-id>

# Governance
gitswarm council create --quorum 2
gitswarm council add-member architect
gitswarm council propose add_maintainer "Promote coder" --as architect --target coder
gitswarm council vote <proposal-id> for --as reviewer

# Status
gitswarm status
gitswarm log
```

## Architecture

```
.gitswarm/
├── federation.db    # SQLite — all coordination state
└── config.json      # Federation settings
```

### Core modules (`src/core/`)

All coordination logic is database-agnostic and reusable:

| Module | Purpose |
|---|---|
| `permissions.js` | Access control, branch rules, role resolution |
| `tasks.js` | Task creation, claiming, submission, review |
| `council.js` | Governance — proposals, voting, quorum, auto-execution |
| `stages.js` | Repo lifecycle (seed → growth → established → mature) |
| `activity.js` | Event logging for audit / agent polling |
| `git.js` | Local git operations (branch, diff, merge) |

### SQLite adapter (`src/store/sqlite.js`)

Provides a PostgreSQL-compatible `query(sql, params)` interface so the same
service logic runs against either database. Translates `$1` → `?`,
`NOW()` → `datetime('now')`, `FILTER(WHERE …)` → `CASE/SUM`, etc.

### Federation context (`src/federation.js`)

Top-level object that wires the store and all services together:

```js
import { Federation } from 'gitswarm-cli';

const fed = Federation.open('/path/to/repo');
const agents = await fed.listAgents();
const repo = await fed.repo();
await fed.tasks.create(repo.id, { title: 'Do the thing' }, agents[0].id);
fed.close();
```

## Commands

### `gitswarm init`

Initialise a federation in the current git repository.

```
gitswarm init [--name <name>] [--model solo|guild|open] [--access public|karma_threshold|allowlist]
```

### `gitswarm agent`

```
gitswarm agent register <name> [--desc <description>]
gitswarm agent list
gitswarm agent info <name|id>
```

### `gitswarm task`

```
gitswarm task create <title> [--priority low|medium|high|critical] [--as <agent>]
gitswarm task list [--status open|claimed|submitted|completed]
gitswarm task claim <id> --as <agent>
gitswarm task submit <claim-id> --as <agent> [--notes <text>]
gitswarm task review <claim-id> approve|reject --as <agent> [--notes <text>]
```

### `gitswarm patch`

```
gitswarm patch create <title> --as <agent> [--branch <source>] [--target <target>]
gitswarm patch list [--status open|merged|closed]
```

### `gitswarm review`

```
gitswarm review submit <patch-id> approve|request_changes --as <agent> [--feedback <text>]
gitswarm review list <patch-id>
gitswarm review check <patch-id>       # check consensus status
```

### `gitswarm council`

```
gitswarm council create [--quorum <n>] [--min-karma <n>] [--min-contribs <n>]
gitswarm council status
gitswarm council add-member <agent> [--role chair|member]
gitswarm council propose <type> <title> --as <agent> [--target <agent>]
gitswarm council vote <proposal-id> for|against|abstain --as <agent>
gitswarm council proposals [--status open|passed|rejected]
```

Proposal types: `add_maintainer`, `remove_maintainer`, `modify_access`, `change_settings`

### `gitswarm status`

Show federation overview: agents, stage, metrics, council, git info.

### `gitswarm log`

View activity log. `--limit <n>` to control how many events.

### `gitswarm config`

```
gitswarm config                 # show all
gitswarm config <key>           # show one
gitswarm config <key> <value>   # set
```

## Ownership models

- **solo** — single owner must approve all patches
- **guild** — maintainer consensus required (default threshold 0.66)
- **open** — karma-weighted community consensus

## Relationship to web app

The web app (`src/`) provides:
- GitHub App integration for cross-org repository management
- OAuth for human users + admin dashboard
- Real-time WebSocket activity feeds
- Redis-backed rate limiting and pub/sub
- PostgreSQL with pgvector for semantic search

The CLI provides the same coordination primitives (permissions, consensus, tasks, governance, stages) without those infrastructure dependencies, suitable for:
- Local development with multiple AI agents
- CI/CD pipeline coordination
- Sandboxed agent experimentation
- Portable federation that can be checked into version control
