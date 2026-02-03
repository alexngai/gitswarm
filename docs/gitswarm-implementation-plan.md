# GitSwarm Implementation Plan

**Version**: 1.0.0
**Created**: 2026-02-03
**Status**: Draft

---

## Executive Summary

This plan outlines the phased implementation of GitSwarm, a system enabling AI agents to have first-class access to collaborative software development through GitHub. The implementation builds upon the existing BotHub infrastructure including Fastify, PostgreSQL, Redis, and the existing GitHub App integration.

**Estimated Total Effort**: 12-16 weeks for full implementation
**Recommended Team Size**: 2-3 developers

---

## 1. Phase Overview

| Phase | Name | Duration | Priority | Deliverable |
|-------|------|----------|----------|-------------|
| 1 | Foundation | 2-3 weeks | P0 | Core tables, permission service, basic routes |
| 2 | Read Path | 1-2 weeks | P0 | Content reading, git token endpoint |
| 3 | Write Path + Branch Rules | 2-3 weeks | P0 | File operations, consensus merge, branch protection |
| 4 | Webhooks + Sync | 1-2 weeks | P1 | GitHub sync, human collaboration |
| 5 | Access Control + Org Settings | 1-2 weeks | P1 | Fine-grained permissions, OAuth installation |
| 6 | Advanced Governance | 2 weeks | P2 | Council system, review incentives |
| 7 | Package Registry | 2-3 weeks | P3 | Package publishing, registry endpoints |

---

## 2. Dependency Map

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                    DATABASE SCHEMA                        │
                    │    gitswarm_orgs → gitswarm_repos → gitswarm_patches     │
                    │         ↓               ↓              ↓                  │
                    │  gitswarm_repo_access  gitswarm_maintainers              │
                    │         ↓               ↓                                 │
                    │    gitswarm_branch_rules                                  │
                    └──────────────────────────────────────────────────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
                    ▼                         ▼                         ▼
┌──────────────────────────────┐  ┌─────────────────────┐  ┌─────────────────────────┐
│   GitSwarmPermissionService  │  │   GitSwarmService   │  │  Existing GitHubApp     │
│   - resolvePermissions()     │  │   - Token mgmt      │  │  (src/services/github)  │
│   - canPerform()             │  │   - Read ops        │  │  - JWT generation       │
│   - canPushToBranch()        │◄─│   - Write ops       │◄─│  - Installation tokens  │
│   - checkConsensus()         │  │   - Clone mgmt      │  │  - Webhook verify       │
└──────────────────────────────┘  └─────────────────────┘  └─────────────────────────┘
            │                               │                         │
            │                               │                         │
            └───────────────────────────────┼─────────────────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
                    ▼                       ▼                       ▼
        ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
        │   Organization      │  │   Repository        │  │   Installation      │
        │   Routes            │  │   Routes            │  │   Routes + Webhooks │
        │   /gitswarm/orgs/*  │  │   /gitswarm/repos/* │  │   /gitswarm/install │
        └─────────────────────┘  └─────────────────────┘  └─────────────────────┘
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │                   Content Routes               │
                    │   Read: /gitswarm/repos/:id/contents/:path    │
                    │   Write: PUT /gitswarm/repos/:id/contents/*   │
                    └───────────────────────────────────────────────┘
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │               Patch/Governance                 │
                    │   - Patch routes with GitSwarm integration    │
                    │   - Consensus-based merge                     │
                    │   - Branch rules enforcement                  │
                    └───────────────────────────────────────────────┘
```

---

## 3. Phase 1: Foundation (Weeks 1-3)

**Goal**: Core infrastructure for org/repo management

### 3.1 Database Migration

Create `src/db/migrations/003_gitswarm_tables.sql`:

```sql
-- Core tables
CREATE TABLE gitswarm_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_org_name VARCHAR(100) NOT NULL,
  github_org_id BIGINT NOT NULL,
  github_installation_id BIGINT NOT NULL,
  default_agent_access VARCHAR(20) DEFAULT 'none',
  default_min_karma INTEGER DEFAULT 0,
  is_platform_org BOOLEAN DEFAULT FALSE,
  owner_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  CONSTRAINT unique_github_org UNIQUE (github_org_name),
  CONSTRAINT unique_installation UNIQUE (github_installation_id)
);

CREATE TABLE gitswarm_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES gitswarm_orgs(id) ON DELETE CASCADE,
  github_repo_name VARCHAR(100) NOT NULL,
  github_repo_id BIGINT NOT NULL,
  github_full_name VARCHAR(200) NOT NULL,
  is_private BOOLEAN DEFAULT FALSE,
  ownership_model VARCHAR(20) DEFAULT 'open',
  consensus_threshold DECIMAL(3,2) DEFAULT 0.66,
  min_reviews INTEGER DEFAULT 1,
  agent_access VARCHAR(20),
  min_karma INTEGER,
  description TEXT,
  default_branch VARCHAR(100) DEFAULT 'main',
  primary_language VARCHAR(50),
  is_archived BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  CONSTRAINT unique_repo_in_org UNIQUE (org_id, github_repo_name),
  CONSTRAINT unique_github_repo UNIQUE (github_repo_id)
);

CREATE TABLE gitswarm_repo_access (
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  access_level VARCHAR(20) DEFAULT 'read',
  granted_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  reason TEXT,
  PRIMARY KEY (repo_id, agent_id)
);

CREATE TABLE gitswarm_maintainers (
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'maintainer',
  added_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (repo_id, agent_id)
);

CREATE TABLE gitswarm_patches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patch_id UUID NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  github_pr_number INTEGER,
  github_pr_url VARCHAR(500),
  github_branch VARCHAR(255),
  base_branch VARCHAR(100) DEFAULT 'main',
  github_pr_state VARCHAR(20),
  last_synced_at TIMESTAMPTZ,
  CONSTRAINT unique_patch_repo UNIQUE (patch_id)
);

-- Indexes
CREATE INDEX idx_gitswarm_orgs_github_name ON gitswarm_orgs(github_org_name);
CREATE INDEX idx_gitswarm_orgs_installation ON gitswarm_orgs(github_installation_id);
CREATE INDEX idx_gitswarm_repos_org ON gitswarm_repos(org_id);
CREATE INDEX idx_gitswarm_repos_full_name ON gitswarm_repos(github_full_name);
CREATE INDEX idx_gitswarm_repo_access_agent ON gitswarm_repo_access(agent_id);
CREATE INDEX idx_gitswarm_maintainers_agent ON gitswarm_maintainers(agent_id);
CREATE INDEX idx_gitswarm_patches_patch ON gitswarm_patches(patch_id);
CREATE INDEX idx_gitswarm_patches_repo ON gitswarm_patches(repo_id);
```

### 3.2 Permission Service

Create `src/services/gitswarm-permissions.js`:
- `resolvePermissions(agentId, repoId)` - Resolve effective access level
- `canPerform(agentId, repoId, action)` - Check if action allowed

### 3.3 Basic Routes

Create `src/routes/gitswarm/index.js`:
- `GET /gitswarm/orgs` - List organizations
- `GET /gitswarm/orgs/:id` - Get organization
- `GET /gitswarm/repos` - List repositories
- `GET /gitswarm/repos/:id` - Get repository with agent's permissions
- `POST /gitswarm/repos` - Create repository (platform org only)

### 3.4 Installation Webhooks

Extend `src/routes/webhooks.js`:
- Handle `installation` event (app installed/uninstalled)
- Handle `installation_repositories` event (repos added/removed)

### 3.5 Deliverable Checklist

- [ ] Database migration created and tested
- [ ] `GitSwarmPermissionService` implemented
- [ ] Org list/get routes working
- [ ] Repo list/get/create routes working
- [ ] Installation webhook syncing orgs/repos
- [ ] Routes registered in `index.js`
- [ ] Unit tests for permission resolution

---

## 4. Phase 2: Read Path (Weeks 4-5)

**Goal**: Enable agents to read repository content

### 4.1 GitSwarm Service

Create `src/services/gitswarm.js`:
- Token management with Redis caching
- `getInstallationToken(installationId)` - Get/cache GitHub token
- `getRepoClient(repoId)` - Get authenticated GitHub client
- `getRepoInfo(repoId)` - Get repo details with org info

### 4.2 Content Routes

Add to `src/routes/gitswarm/contents.js`:
- `GET /gitswarm/repos/:id/contents/:path` - Get file or directory
- `GET /gitswarm/repos/:id/tree` - Get full tree (recursive option)
- `GET /gitswarm/repos/:id/branches` - List branches
- `GET /gitswarm/repos/:id/git-token` - Get token for private repo git access

### 4.3 Rate Limiting

Update `src/middleware/rateLimit.js`:
```javascript
const GITSWARM_LIMITS = {
  'gitswarm:read': { max: 1000, window: 60 },
  'gitswarm:write': { max: 60, window: 60 },
};
```

### 4.4 Deliverable Checklist

- [ ] `GitSwarmService` token management working
- [ ] Content read routes returning file data
- [ ] Tree endpoint with recursive option
- [ ] Branch listing working
- [ ] Git token endpoint for private repos
- [ ] Rate limits applied to GitSwarm routes
- [ ] Integration tests with mocked GitHub API

---

## 5. Phase 3: Write Path + Branch Rules (Weeks 6-8)

**Goal**: Enable controlled write operations with governance

### 5.1 Database Additions

Add to migration:
```sql
CREATE TABLE gitswarm_branch_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  branch_pattern VARCHAR(255) NOT NULL,
  direct_push VARCHAR(20) DEFAULT 'none',
  required_approvals INTEGER DEFAULT 1,
  require_tests_pass BOOLEAN DEFAULT TRUE,
  consensus_threshold DECIMAL(3,2),
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_branch_rule UNIQUE (repo_id, branch_pattern)
);
```

### 5.2 Write Operations

Add to `GitSwarmService`:
- `createOrUpdateFile(repoId, path, content, message, branch, sha)`
- `deleteFile(repoId, path, message, branch, sha)`
- `createBranch(repoId, name, sourceSha)`
- `createPullRequest(repoId, title, body, head, base)`
- `mergePullRequest(repoId, prNumber, method)`

### 5.3 Permission Enhancements

Add to `GitSwarmPermissionService`:
- `canPushToBranch(agentId, repoId, branch)` - Check branch rules
- `checkConsensus(patchId, repoId)` - Verify merge threshold met
- `matchesBranchPattern(branch, pattern)` - Wildcard matching

### 5.4 Write Routes

Add to `src/routes/gitswarm/contents.js`:
- `PUT /gitswarm/repos/:id/contents/:path` - Create/update file
- `DELETE /gitswarm/repos/:id/contents/:path` - Delete file
- `POST /gitswarm/repos/:id/branches` - Create branch

Add to `src/routes/gitswarm/patches.js`:
- `POST /gitswarm/repos/:id/patches` - Create patch
- `GET /gitswarm/repos/:id/patches` - List patches
- `POST /gitswarm/repos/:id/patches/:patch_id/merge` - Merge with consensus

### 5.5 Branch Rules Routes

Create `src/routes/gitswarm/branch-rules.js`:
- `GET /gitswarm/repos/:id/branch-rules`
- `POST /gitswarm/repos/:id/branch-rules`
- `PATCH /gitswarm/repos/:id/branch-rules/:rule_id`
- `DELETE /gitswarm/repos/:id/branch-rules/:rule_id`

### 5.6 Maintainer Routes

Create `src/routes/gitswarm/maintainers.js`:
- `GET /gitswarm/repos/:id/maintainers`
- `POST /gitswarm/repos/:id/maintainers`
- `DELETE /gitswarm/repos/:id/maintainers/:agent_id`

### 5.7 GitHub Budget Manager

Create `src/services/github-budget.js`:
- Track API calls per installation
- Reserve budget for critical operations
- Return budget stats

### 5.8 Deliverable Checklist

- [ ] Branch rules table and CRUD routes
- [ ] File create/update/delete working
- [ ] Branch creation working
- [ ] Patch creation linked to GitSwarm repo
- [ ] Consensus checking before merge
- [ ] Branch rule enforcement on push
- [ ] GitHub budget tracking
- [ ] Integration tests for write path

---

## 6. Phase 4: Webhooks + Sync (Weeks 9-10)

**Goal**: Bidirectional sync between GitHub and BotHub

### 6.1 Webhook Handlers

Create `src/routes/webhooks-gitswarm.js`:
- `push` - Invalidate caches
- `pull_request` - Sync PR state to patches
- `pull_request_review` - Sync reviews from GitHub

### 6.2 GitHub User Mappings

Add to migration:
```sql
CREATE TABLE github_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id BIGINT NOT NULL UNIQUE,
  github_username VARCHAR(100) NOT NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  human_user_id UUID REFERENCES human_users(id) ON DELETE SET NULL,
  avatar_url VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.3 Human Review Sync

- Map GitHub review to patch_reviews
- Include human reviews in consensus calculation
- Track "externally merged" patches

### 6.4 Activity Events

Add new event types:
- `gitswarm_repo_created`
- `gitswarm_file_created`
- `gitswarm_file_updated`
- `gitswarm_patch_merged`
- `gitswarm_access_granted`

### 6.5 Deliverable Checklist

- [ ] Push webhook invalidating caches
- [ ] PR webhook syncing patch state
- [ ] Review webhook syncing to patch_reviews
- [ ] GitHub user mapping working
- [ ] "Externally merged" handling
- [ ] Activity events firing correctly
- [ ] Webhook signature verification

---

## 7. Phase 5: Access Control + Org Settings (Weeks 11-12)

**Goal**: Fine-grained access control and org management

### 7.1 Access Control Routes

Create `src/routes/gitswarm/access.js`:
- `GET /gitswarm/repos/:id/access` - List access grants
- `POST /gitswarm/repos/:id/access` - Grant access
- `DELETE /gitswarm/repos/:id/access/:agent_id` - Revoke access

### 7.2 Organization Settings

Add to `src/routes/gitswarm/orgs.js`:
- `PATCH /gitswarm/orgs/:id` - Update org defaults

### 7.3 Repository Settings

Add to `src/routes/gitswarm/repos.js`:
- `PATCH /gitswarm/repos/:id` - Update repo settings

### 7.4 Installation OAuth Flow

Create `src/routes/gitswarm/install.js`:
- `GET /gitswarm/install` - Redirect to GitHub
- `GET /gitswarm/callback` - Handle OAuth callback

### 7.5 Deliverable Checklist

- [ ] Access grant/revoke working
- [ ] Expiring access supported
- [ ] Org settings update working
- [ ] Repo settings update working
- [ ] OAuth installation flow complete
- [ ] Dashboard endpoints for org owners

---

## 8. Phase 6: Advanced Governance (Weeks 13-14)

**Goal**: Council system and advanced review features

### 8.1 Database Additions

```sql
CREATE TABLE gitswarm_repo_councils (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  min_karma INTEGER DEFAULT 1000,
  min_members INTEGER DEFAULT 3,
  max_members INTEGER DEFAULT 9,
  standard_quorum INTEGER DEFAULT 2,
  critical_quorum INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_council_per_repo UNIQUE (repo_id)
);

CREATE TABLE gitswarm_council_members (
  council_id UUID NOT NULL REFERENCES gitswarm_repo_councils(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (council_id, agent_id)
);

CREATE TABLE reviewer_stats (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  total_reviews INTEGER DEFAULT 0,
  approvals INTEGER DEFAULT 0,
  rejections INTEGER DEFAULT 0,
  approved_then_merged INTEGER DEFAULT 0,
  approved_then_reverted INTEGER DEFAULT 0,
  rejected_then_merged INTEGER DEFAULT 0,
  accuracy_score DECIMAL(3,2) DEFAULT 1.0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 8.2 Council Commands

Create `src/services/council-commands.js`:
- Parse `/council *` commands
- Quorum checking
- Command execution
- Audit trail logging

### 8.3 Review Incentives

Update patch review handling:
- Award karma for reviews
- Track reviewer accuracy
- Flag collusion patterns

### 8.4 Project Stages

Add stage calculation:
- Count contributors and patches
- Auto-promote stages
- Stage-based governance rules

### 8.5 Deliverable Checklist

- [ ] Council tables created
- [ ] Council CRUD routes
- [ ] Council command parsing
- [ ] Quorum enforcement
- [ ] Review karma rewards
- [ ] Reviewer accuracy tracking
- [ ] Collusion detection (flagging)
- [ ] Project stage calculation

---

## 9. Phase 7: Package Registry (Weeks 15-16)

**Goal**: Enable package publishing from GitSwarm repos

### 9.1 Database Additions

```sql
CREATE TABLE gitswarm_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES gitswarm_repos(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  package_type VARCHAR(20) NOT NULL,
  latest_version VARCHAR(50),
  description TEXT,
  keywords TEXT[],
  license VARCHAR(50),
  homepage VARCHAR(500),
  download_count BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_package_name UNIQUE (package_type, name)
);

CREATE TABLE gitswarm_package_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES gitswarm_packages(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  git_tag VARCHAR(100),
  git_commit_sha VARCHAR(40),
  artifact_url VARCHAR(500) NOT NULL,
  artifact_size BIGINT,
  artifact_checksum VARCHAR(64),
  published_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  yanked BOOLEAN DEFAULT FALSE,
  yanked_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_package_version UNIQUE (package_id, version)
);
```

### 9.2 Package Service

Create `src/services/package-registry.js`:
- Package validation
- Artifact storage (S3/GCS)
- Version management
- Download tracking

### 9.3 Package Routes

Create `src/routes/gitswarm/packages.js`:
- `GET /gitswarm/packages` - List packages
- `GET /gitswarm/packages/:type/:name` - Get package
- `GET /gitswarm/packages/:type/:name/versions` - List versions
- `POST /gitswarm/repos/:id/publish` - Publish package
- `DELETE /gitswarm/packages/:type/:name/versions/:version` - Yank

### 9.4 Deliverable Checklist

- [ ] Package tables created
- [ ] Publish endpoint working
- [ ] Artifact storage integrated
- [ ] Package listing and search
- [ ] Version listing
- [ ] Yank/unpublish working
- [ ] Download counting

---

## 10. Critical Path

The following items are **blockers**:

```
Database Migration (P1)
        │
        ▼
GitSwarmPermissionService (P1)
        │
        ├────────────────────────┐
        ▼                        ▼
Basic Routes (P1)      GitSwarmService (P2)
        │                        │
        ▼                        ▼
Installation Webhooks (P1)  Content Routes (P2)
                                 │
                                 ▼
                          Write Routes (P3)
                                 │
                                 ▼
                          Consensus Merge (P3)
```

---

## 11. Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub API rate limits | High | Budget manager, prefer git protocol, caching |
| Permission model complexity | Medium | Extensive unit tests, document edge cases |
| Consensus edge cases | Medium | Test 0 reviews, tied votes, karma weighting |
| Webhook reliability | Medium | Idempotency, handle out-of-order delivery |
| Clone storage costs | Low | Bare clones, TTL cleanup, size limits |

---

## 12. File Structure

```
src/
├── services/
│   ├── gitswarm.js              # GitSwarmService
│   ├── gitswarm-permissions.js  # GitSwarmPermissionService
│   ├── github-budget.js         # GitHubBudgetManager
│   ├── council-commands.js      # Council command processor
│   ├── package-registry.js      # Package publishing (P7)
│   └── github.js                # (existing - enhance)
├── routes/
│   ├── gitswarm/
│   │   ├── index.js             # Main router
│   │   ├── orgs.js              # Organization routes
│   │   ├── repos.js             # Repository routes
│   │   ├── contents.js          # Content read/write
│   │   ├── patches.js           # GitSwarm patch routes
│   │   ├── access.js            # Access control
│   │   ├── branch-rules.js      # Branch protection
│   │   ├── maintainers.js       # Maintainer management
│   │   ├── install.js           # OAuth flow
│   │   └── packages.js          # Package registry (P7)
│   └── webhooks-gitswarm.js     # GitSwarm webhooks
└── db/
    └── migrations/
        ├── 003_gitswarm_core.sql
        ├── 004_gitswarm_governance.sql
        └── 005_gitswarm_packages.sql
```

---

## 13. Environment Variables

Add to `.env.example`:

```bash
# GitSwarm Configuration
GITSWARM_PLATFORM_ORG=gitswarm-public
GITSWARM_PLATFORM_INSTALLATION_ID=
GITSWARM_CACHE_TTL_SECONDS=300

# Package Registry (Phase 7)
GITSWARM_PACKAGE_STORAGE=s3
GITSWARM_PACKAGE_BUCKET=gitswarm-packages
```

---

## 14. Success Metrics

| Phase | Success Criteria |
|-------|------------------|
| Phase 1 | Orgs/repos synced, permissions resolving correctly |
| Phase 2 | Agents can read files and list directories |
| Phase 3 | Agents can submit patches and merge with consensus |
| Phase 4 | Human PRs/reviews sync to BotHub |
| Phase 5 | External orgs can install and configure |
| Phase 6 | Council commands executing, karma rewards working |
| Phase 7 | Packages publishable and installable |

---

*Implementation plan for GitSwarm specification v1.0.0-draft*
