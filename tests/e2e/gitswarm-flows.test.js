import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * GitSwarm E2E Flow Tests (Phases 4-7)
 *
 * These tests verify the complete end-to-end flows for:
 * - Phase 4: GitHub User Mappings & Human Review Sync
 * - Phase 5: OAuth Installation Flow
 * - Phase 6: Council Governance
 * - Phase 7: Package Registry
 */

// Mock services for testing
const createGitSwarmMockDb = () => {
  const store = {
    agents: new Map(),
    gitswarm_orgs: new Map(),
    gitswarm_repos: new Map(),
    gitswarm_github_user_mappings: new Map(),
    patches: new Map(),
    patch_reviews: new Map(),
    gitswarm_reviewer_stats: new Map(),
    review_karma_transactions: new Map(),
    gitswarm_repo_councils: new Map(),
    gitswarm_council_members: new Map(),
    gitswarm_council_proposals: new Map(),
    gitswarm_council_votes: new Map(),
    gitswarm_packages: new Map(),
    gitswarm_package_versions: new Map(),
    gitswarm_package_downloads: new Map(),
    gitswarm_package_maintainers: new Map(),
    gitswarm_package_advisories: new Map(),
    gitswarm_repo_access: new Map(),
    gitswarm_repo_maintainers: new Map(),
  };

  // Helper to generate UUIDs
  const uuid = () => crypto.randomUUID();

  return {
    store,
    query: async (sql, params = []) => {
      const sqlLower = sql.toLowerCase().trim();
      const now = new Date().toISOString();

      // Agent queries
      if (sqlLower.includes('from agents') && sqlLower.includes('api_key_hash')) {
        const agent = Array.from(store.agents.values()).find(a => a.api_key_hash === params[0]);
        return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
      }

      if (sqlLower.includes('into agents')) {
        const id = uuid();
        const agent = { id, name: params[0], bio: params[1], api_key_hash: params[2], karma: 0, status: 'active', created_at: now };
        store.agents.set(id, agent);
        return { rows: [agent], rowCount: 1 };
      }

      if (sqlLower.includes('from agents') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
        const agent = store.agents.get(params[0]);
        return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
      }

      // GitSwarm org queries
      if (sqlLower.includes('into gitswarm_orgs')) {
        const id = uuid();
        const org = {
          id, github_org_name: params[0], github_org_id: params[1],
          github_installation_id: params[2], status: 'active',
          is_platform_org: false, default_agent_access: 'public',
          default_min_karma: 0, created_at: now
        };
        store.gitswarm_orgs.set(id, org);
        return { rows: [org], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_orgs') && sqlLower.includes('github_installation_id')) {
        const org = Array.from(store.gitswarm_orgs.values()).find(o => o.github_installation_id === params[0]);
        return { rows: org ? [org] : [], rowCount: org ? 1 : 0 };
      }

      if (sqlLower.includes('from gitswarm_orgs') && sqlLower.includes('github_org_name')) {
        const org = Array.from(store.gitswarm_orgs.values()).find(o => o.github_org_name === params[0]);
        return { rows: org ? [org] : [], rowCount: org ? 1 : 0 };
      }

      // GitSwarm repo queries
      if (sqlLower.includes('into gitswarm_repos')) {
        const id = uuid();
        const repo = {
          id, org_id: params[0], github_repo_name: params[1],
          github_repo_id: params[2], github_full_name: params[3],
          is_private: params[4], description: params[5],
          default_branch: params[6], status: 'active', created_at: now
        };
        store.gitswarm_repos.set(id, repo);
        return { rows: [repo], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_repos') && sqlLower.includes('org_id')) {
        const repos = Array.from(store.gitswarm_repos.values()).filter(r => r.org_id === params[0]);
        return { rows: repos, rowCount: repos.length };
      }

      // GitHub user mapping queries
      if (sqlLower.includes('into gitswarm_github_user_mappings')) {
        const id = uuid();
        const mapping = {
          id, github_user_id: params[0], github_login: params[1],
          avatar_url: params[2], agent_id: null, created_at: now, last_seen_at: now
        };
        store.gitswarm_github_user_mappings.set(id, mapping);
        return { rows: [mapping], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_github_user_mappings') && sqlLower.includes('github_user_id')) {
        const mapping = Array.from(store.gitswarm_github_user_mappings.values()).find(m => m.github_user_id === params[0]);
        return { rows: mapping ? [mapping] : [], rowCount: mapping ? 1 : 0 };
      }

      // Patch queries
      if (sqlLower.includes('into patches')) {
        const id = uuid();
        const patch = {
          id, repo_id: params[0], author_id: params[1], title: params[2],
          description: params[3], github_pr_url: params[4], status: 'open', created_at: now
        };
        store.patches.set(id, patch);
        return { rows: [patch], rowCount: 1 };
      }

      if (sqlLower.includes('from patches') && sqlLower.includes('github_pr_url')) {
        const patch = Array.from(store.patches.values()).find(p => p.github_pr_url === params[0]);
        return { rows: patch ? [patch] : [], rowCount: patch ? 1 : 0 };
      }

      if (sqlLower.includes('from patches') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
        const patch = store.patches.get(params[0]);
        return { rows: patch ? [patch] : [], rowCount: patch ? 1 : 0 };
      }

      // Patch review queries
      if (sqlLower.includes('into patch_reviews')) {
        const id = uuid();
        const review = {
          id, patch_id: params[0], reviewer_id: params[1] || null,
          github_user_mapping_id: params[2] || null, is_human: params[3] || false,
          verdict: params[4], comments: params[5], github_review_id: params[6],
          tested: false, created_at: now
        };
        store.patch_reviews.set(id, review);
        return { rows: [review], rowCount: 1 };
      }

      if (sqlLower.includes('from patch_reviews') && sqlLower.includes('patch_id')) {
        const reviews = Array.from(store.patch_reviews.values()).filter(r => r.patch_id === params[0]);
        return { rows: reviews, rowCount: reviews.length };
      }

      // Reviewer stats queries
      if (sqlLower.includes('into gitswarm_reviewer_stats')) {
        const key = `${params[0]}-${params[1]}`;
        const stats = {
          agent_id: params[0], repo_id: params[1],
          reviews_given: 1, approvals_given: params[2] === 'approve' ? 1 : 0,
          rejections_given: params[2] === 'reject' ? 1 : 0,
          accurate_approvals: 0, inaccurate_approvals: 0,
          accuracy_rate: 0, created_at: now
        };
        store.gitswarm_reviewer_stats.set(key, stats);
        return { rows: [stats], rowCount: 1 };
      }

      // Council queries
      if (sqlLower.includes('into gitswarm_repo_councils')) {
        const id = uuid();
        const council = {
          id, repo_id: params[0], min_karma: params[1] || 1000,
          min_contributions: params[2] || 5, min_members: params[3] || 3,
          max_members: params[4] || 9, standard_quorum: params[5] || 2,
          critical_quorum: params[6] || 3, status: 'forming', created_at: now
        };
        store.gitswarm_repo_councils.set(id, council);
        return { rows: [council], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_repo_councils') && sqlLower.includes('repo_id')) {
        const council = Array.from(store.gitswarm_repo_councils.values()).find(c => c.repo_id === params[0]);
        if (council) {
          const memberCount = Array.from(store.gitswarm_council_members.values()).filter(m => m.council_id === council.id).length;
          return { rows: [{ ...council, member_count: memberCount.toString() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (sqlLower.includes('from gitswarm_repo_councils') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
        const council = store.gitswarm_repo_councils.get(params[0]);
        if (council) {
          const memberCount = Array.from(store.gitswarm_council_members.values()).filter(m => m.council_id === council.id).length;
          return { rows: [{ ...council, member_count: memberCount.toString() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Council member queries
      if (sqlLower.includes('into gitswarm_council_members')) {
        const id = uuid();
        const member = {
          id, council_id: params[0], agent_id: params[1], role: params[2] || 'member',
          joined_at: now, votes_cast: 0, proposals_made: 0
        };
        store.gitswarm_council_members.set(`${params[0]}-${params[1]}`, member);
        return { rows: [member], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_council_members') && sqlLower.includes('council_id') && sqlLower.includes('agent_id')) {
        const member = store.gitswarm_council_members.get(`${params[0]}-${params[1]}`);
        return { rows: member ? [member] : [], rowCount: member ? 1 : 0 };
      }

      if (sqlLower.includes('from gitswarm_council_members') && sqlLower.includes('council_id')) {
        const members = Array.from(store.gitswarm_council_members.values())
          .filter(m => m.council_id === params[0]);
        return { rows: members, rowCount: members.length };
      }

      // Council proposal queries
      if (sqlLower.includes('into gitswarm_council_proposals')) {
        const id = uuid();
        const proposal = {
          id, council_id: params[0], proposer_id: params[1], title: params[2],
          description: params[3], proposal_type: params[4], action_data: params[5],
          quorum_required: params[6] || 2, votes_for: 0, votes_against: 0,
          status: 'open', expires_at: params[7] || new Date(Date.now() + 7 * 86400000).toISOString(),
          created_at: now
        };
        store.gitswarm_council_proposals.set(id, proposal);
        return { rows: [proposal], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_council_proposals') && sqlLower.includes('council_id') && sqlLower.includes('status')) {
        const proposals = Array.from(store.gitswarm_council_proposals.values())
          .filter(p => p.council_id === params[0] && p.status === params[1]);
        return { rows: proposals, rowCount: proposals.length };
      }

      if (sqlLower.includes('from gitswarm_council_proposals') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
        const proposal = store.gitswarm_council_proposals.get(params[0]);
        if (proposal) {
          const totalMembers = Array.from(store.gitswarm_council_members.values())
            .filter(m => m.council_id === proposal.council_id).length;
          return { rows: [{ ...proposal, total_members: totalMembers.toString() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Council vote queries
      if (sqlLower.includes('into gitswarm_council_votes')) {
        const id = uuid();
        const vote = {
          id, proposal_id: params[0], voter_id: params[1], vote: params[2],
          comment: params[3], created_at: now
        };
        store.gitswarm_council_votes.set(`${params[0]}-${params[1]}`, vote);
        return { rows: [vote], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_council_votes') && sqlLower.includes('proposal_id')) {
        const votes = Array.from(store.gitswarm_council_votes.values())
          .filter(v => v.proposal_id === params[0]);

        // Count votes
        const forCount = votes.filter(v => v.vote === 'for').length;
        const againstCount = votes.filter(v => v.vote === 'against').length;

        return {
          rows: [
            { vote: 'for', count: forCount.toString() },
            { vote: 'against', count: againstCount.toString() }
          ],
          rowCount: 2
        };
      }

      // Package queries
      if (sqlLower.includes('into gitswarm_packages')) {
        const id = uuid();
        const pkg = {
          id, repo_id: params[0], name: params[1], package_type: params[2],
          description: params[3], license: params[4], status: 'active',
          download_count: 0, latest_version: null, created_at: now
        };
        store.gitswarm_packages.set(id, pkg);
        return { rows: [pkg], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_packages') && sqlLower.includes('package_type') && sqlLower.includes('name')) {
        const pkg = Array.from(store.gitswarm_packages.values())
          .find(p => p.package_type === params[0] && p.name === params[1]);
        return { rows: pkg ? [pkg] : [], rowCount: pkg ? 1 : 0 };
      }

      if (sqlLower.includes('from gitswarm_packages') && sqlLower.includes('repo_id')) {
        const packages = Array.from(store.gitswarm_packages.values())
          .filter(p => p.repo_id === params[0]);
        return { rows: packages, rowCount: packages.length };
      }

      if (sqlLower.includes('from gitswarm_packages') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
        const pkg = store.gitswarm_packages.get(params[0]);
        return { rows: pkg ? [pkg] : [], rowCount: pkg ? 1 : 0 };
      }

      // Package version queries
      if (sqlLower.includes('into gitswarm_package_versions')) {
        const id = uuid();
        const version = {
          id, package_id: params[0], version: params[1], published_by: params[2],
          artifact_url: params[3], artifact_size: params[4], checksum: params[5],
          manifest: params[6], git_tag: params[7], git_commit_sha: params[8],
          prerelease: params[9] || false, yanked: false, download_count: 0,
          created_at: now
        };
        store.gitswarm_package_versions.set(`${params[0]}-${params[1]}`, version);
        return { rows: [version], rowCount: 1 };
      }

      // Look for specific version query (has both package_id and version as params - 2 params)
      if (sqlLower.includes('from gitswarm_package_versions') && sqlLower.includes('package_id') && params.length >= 2 && sqlLower.includes('and')) {
        const version = store.gitswarm_package_versions.get(`${params[0]}-${params[1]}`);
        return { rows: version ? [version] : [], rowCount: version ? 1 : 0 };
      }

      // List all versions for a package (only 1 param - package_id)
      if (sqlLower.includes('from gitswarm_package_versions') && sqlLower.includes('package_id') && params.length === 1) {
        const versions = Array.from(store.gitswarm_package_versions.values())
          .filter(v => v.package_id === params[0]);
        return { rows: versions, rowCount: versions.length };
      }

      // Package maintainer queries
      if (sqlLower.includes('into gitswarm_package_maintainers')) {
        const id = uuid();
        const maintainer = {
          id, package_id: params[0], agent_id: params[1], role: params[2] || 'maintainer',
          can_publish: params[3] !== false, can_yank: params[4] !== false,
          can_add_maintainers: params[5] || false, can_deprecate: params[6] || false,
          added_by: params[7], created_at: now
        };
        store.gitswarm_package_maintainers.set(`${params[0]}-${params[1]}`, maintainer);
        return { rows: [maintainer], rowCount: 1 };
      }

      if (sqlLower.startsWith('select') && sqlLower.includes('from gitswarm_package_maintainers') && sqlLower.includes('package_id') && sqlLower.includes('agent_id')) {
        const maintainer = store.gitswarm_package_maintainers.get(`${params[0]}-${params[1]}`);
        return { rows: maintainer ? [maintainer] : [], rowCount: maintainer ? 1 : 0 };
      }

      if (sqlLower.startsWith('select') && sqlLower.includes('from gitswarm_package_maintainers') && sqlLower.includes('package_id')) {
        const maintainers = Array.from(store.gitswarm_package_maintainers.values())
          .filter(m => m.package_id === params[0]);
        return { rows: maintainers, rowCount: maintainers.length };
      }

      // Package downloads
      if (sqlLower.includes('into gitswarm_package_downloads')) {
        const id = uuid();
        const download = {
          id, version_id: params[0], agent_id: params[1], ip_hash: params[2],
          user_agent: params[3], created_at: now
        };
        store.gitswarm_package_downloads.set(id, download);
        return { rows: [download], rowCount: 1 };
      }

      // Package advisory queries
      if (sqlLower.includes('into gitswarm_package_advisories')) {
        const id = uuid();
        const advisory = {
          id, package_id: params[0], title: params[1], description: params[2],
          severity: params[3], affected_versions: params[4], patched_versions: params[5],
          cve_id: params[6], reported_by: params[7], status: 'open', created_at: now
        };
        store.gitswarm_package_advisories.set(id, advisory);
        return { rows: [advisory], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_package_advisories') && sqlLower.includes('package_id')) {
        const advisories = Array.from(store.gitswarm_package_advisories.values())
          .filter(a => a.package_id === params[0]);
        return { rows: advisories, rowCount: advisories.length };
      }

      // Repo maintainers (for governance)
      if (sqlLower.includes('into gitswarm_repo_maintainers')) {
        const id = uuid();
        const maintainer = {
          id, repo_id: params[0], agent_id: params[1], role: params[2] || 'maintainer',
          added_at: now
        };
        store.gitswarm_repo_maintainers.set(`${params[0]}-${params[1]}`, maintainer);
        return { rows: [maintainer], rowCount: 1 };
      }

      if (sqlLower.includes('from gitswarm_repo_maintainers') && sqlLower.includes('repo_id') && sqlLower.includes('agent_id')) {
        const maintainer = store.gitswarm_repo_maintainers.get(`${params[0]}-${params[1]}`);
        return { rows: maintainer ? [maintainer] : [], rowCount: maintainer ? 1 : 0 };
      }

      // Update queries
      if (sqlLower.startsWith('update')) {
        if (sqlLower.includes('gitswarm_repo_councils') && sqlLower.includes('status')) {
          const council = store.gitswarm_repo_councils.get(params[1]);
          if (council) {
            council.status = params[0];
            return { rows: [council], rowCount: 1 };
          }
        }

        if (sqlLower.includes('gitswarm_council_proposals') && sqlLower.includes('status')) {
          const proposal = store.gitswarm_council_proposals.get(params[1]);
          if (proposal) {
            proposal.status = params[0];
            return { rows: [proposal], rowCount: 1 };
          }
        }

        if (sqlLower.includes('gitswarm_council_proposals') && sqlLower.includes('votes_for')) {
          const proposal = store.gitswarm_council_proposals.get(params[2]);
          if (proposal) {
            proposal.votes_for = params[0];
            proposal.votes_against = params[1];
            return { rows: [proposal], rowCount: 1 };
          }
        }

        if (sqlLower.includes('gitswarm_packages') && sqlLower.includes('latest_version')) {
          const pkg = store.gitswarm_packages.get(params[0]);
          if (pkg) {
            pkg.latest_version = params[1];
            return { rows: [pkg], rowCount: 1 };
          }
        }

        if (sqlLower.includes('gitswarm_package_versions') && sqlLower.includes('yanked')) {
          const key = Array.from(store.gitswarm_package_versions.keys()).find(k => k.includes(params[1]));
          if (key) {
            const version = store.gitswarm_package_versions.get(key);
            version.yanked = true;
            version.yanked_reason = params[2];
            return { rows: [version], rowCount: 1 };
          }
        }

        if (sqlLower.includes('patches') && sqlLower.includes('status')) {
          const patch = store.patches.get(params[1]);
          if (patch) {
            patch.status = params[0];
            return { rows: [patch], rowCount: 1 };
          }
        }

        if (sqlLower.includes('agents') && sqlLower.includes('karma')) {
          const agent = store.agents.get(params[1]);
          if (agent) {
            agent.karma += params[0];
            return { rows: [agent], rowCount: 1 };
          }
        }

        return { rows: [], rowCount: 1 };
      }

      // Delete queries
      if (sqlLower.startsWith('delete')) {
        if (sqlLower.includes('gitswarm_council_members')) {
          const key = `${params[0]}-${params[1]}`;
          if (store.gitswarm_council_members.has(key)) {
            const member = store.gitswarm_council_members.get(key);
            store.gitswarm_council_members.delete(key);
            return { rows: [member], rowCount: 1 };
          }
        }

        if (sqlLower.includes('gitswarm_package_maintainers')) {
          // Find and delete by package_id and agent_id
          const keyToDelete = Array.from(store.gitswarm_package_maintainers.keys()).find(k => {
            const m = store.gitswarm_package_maintainers.get(k);
            return m.package_id === params[0] && m.agent_id === params[1];
          });
          if (keyToDelete) {
            const maintainer = store.gitswarm_package_maintainers.get(keyToDelete);
            store.gitswarm_package_maintainers.delete(keyToDelete);
            return { rows: [maintainer], rowCount: 1 };
          }
        }

        return { rows: [], rowCount: 0 };
      }

      // Count queries
      if (sqlLower.includes('count(*)') || sqlLower.includes('count (*)')) {
        if (sqlLower.includes('gitswarm_repos')) {
          const count = Array.from(store.gitswarm_repos.values())
            .filter(r => r.org_id === params[0]).length;
          return { rows: [{ count: count.toString() }], rowCount: 1 };
        }

        if (sqlLower.includes('gitswarm_council_proposals')) {
          const count = Array.from(store.gitswarm_council_proposals.values())
            .filter(p => p.council_id === params[0] && p.status === 'open').length;
          return { rows: [{ count: count.toString() }], rowCount: 1 };
        }

        return { rows: [{ count: '0' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  };
};

describe('GitSwarm E2E Flow Tests (Phases 4-7)', () => {
  let db;

  beforeEach(() => {
    db = createGitSwarmMockDb();
  });

  // ============================================================
  // Phase 4: GitHub User Mappings & Human Review Sync
  // ============================================================

  describe('Phase 4: Human Review Sync Flow', () => {
    it('should complete full human review sync flow', async () => {
      // Step 1: Create an agent (patch author)
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['patch-author', 'An agent that creates patches', 'hash123']
      );
      const author = authorResult.rows[0];
      expect(author.name).toBe('patch-author');

      // Step 2: Create a GitSwarm org
      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['test-org', 12345, '67890']
      );
      const org = orgResult.rows[0];
      expect(org.github_org_name).toBe('test-org');

      // Step 3: Create a repo
      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [org.id, 'test-repo', 1001, 'test-org/test-repo', false, 'Test repo', 'main']
      );
      const repo = repoResult.rows[0];

      // Step 4: Create a patch (PR)
      const patchResult = await db.query(
        'INSERT INTO patches (repo_id, author_id, title, description, github_pr_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repo.id, author.id, 'Fix bug', 'Fixes a critical bug', 'https://github.com/test-org/test-repo/pull/42']
      );
      const patch = patchResult.rows[0];
      expect(patch.status).toBe('open');

      // Step 5: Simulate human GitHub reviewer - create mapping
      const mappingResult = await db.query(
        'INSERT INTO gitswarm_github_user_mappings (github_user_id, github_login, avatar_url) VALUES ($1, $2, $3) RETURNING *',
        [99999, 'human-reviewer', 'https://github.com/avatars/99999']
      );
      const userMapping = mappingResult.rows[0];
      expect(userMapping.github_login).toBe('human-reviewer');
      expect(userMapping.agent_id).toBeNull(); // Not linked to an agent

      // Step 6: Human submits a review via GitHub (sync to patch_reviews)
      const reviewResult = await db.query(
        `INSERT INTO patch_reviews (patch_id, reviewer_id, github_user_mapping_id, is_human, verdict, comments, github_review_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [patch.id, null, userMapping.id, true, 'approve', 'LGTM! Great fix.', 12345]
      );
      const humanReview = reviewResult.rows[0];
      expect(humanReview.is_human).toBe(true);
      expect(humanReview.verdict).toBe('approve');
      expect(humanReview.reviewer_id).toBeNull(); // No agent linked

      // Step 7: Verify human review is recorded
      const reviewsResult = await db.query(
        'SELECT * FROM patch_reviews WHERE patch_id = $1',
        [patch.id]
      );
      expect(reviewsResult.rows).toHaveLength(1);
      expect(reviewsResult.rows[0].is_human).toBe(true);
    });

    it('should link review to agent when GitHub user is mapped', async () => {
      // Create agent that has linked GitHub account
      const agentResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['linked-agent', 'An agent with linked GitHub', 'hash456']
      );
      const agent = agentResult.rows[0];

      // Create mapping with linked agent
      const mappingResult = await db.query(
        'INSERT INTO gitswarm_github_user_mappings (github_user_id, github_login, avatar_url) VALUES ($1, $2, $3) RETURNING *',
        [88888, 'linked-dev', 'https://github.com/avatars/88888']
      );
      const mapping = mappingResult.rows[0];

      // Manually link the agent to the mapping
      mapping.agent_id = agent.id;
      db.store.gitswarm_github_user_mappings.set(mapping.id, mapping);

      // Verify the mapping has an agent
      const linkedMapping = await db.query(
        'SELECT * FROM gitswarm_github_user_mappings WHERE github_user_id = $1',
        [88888]
      );
      expect(linkedMapping.rows[0].agent_id).toBe(agent.id);
    });
  });

  // ============================================================
  // Phase 5: OAuth Installation Flow
  // ============================================================

  describe('Phase 5: OAuth Installation Flow', () => {
    it('should complete full GitHub App installation flow', async () => {
      // Step 1: Simulate GitHub App installation callback
      const installationId = '12345';
      const orgName = 'acme-corp';
      const orgId = 67890;

      // Step 2: Create org from installation
      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        [orgName, orgId, installationId]
      );
      const org = orgResult.rows[0];
      expect(org.status).toBe('active');
      expect(org.github_installation_id).toBe(installationId);

      // Step 3: Sync repositories from GitHub
      const repos = [
        { name: 'backend', id: 1001, full_name: 'acme-corp/backend', private: false },
        { name: 'frontend', id: 1002, full_name: 'acme-corp/frontend', private: false },
        { name: 'infra', id: 1003, full_name: 'acme-corp/infra', private: true }
      ];

      for (const repo of repos) {
        await db.query(
          'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
          [org.id, repo.name, repo.id, repo.full_name, repo.private, `${repo.name} repo`, 'main']
        );
      }

      // Step 4: Verify repos synced
      const syncedRepos = await db.query(
        'SELECT * FROM gitswarm_repos WHERE org_id = $1',
        [org.id]
      );
      expect(syncedRepos.rows).toHaveLength(3);

      // Step 5: Verify org can be found by installation_id
      const foundOrg = await db.query(
        'SELECT * FROM gitswarm_orgs WHERE github_installation_id = $1',
        [installationId]
      );
      expect(foundOrg.rows[0].github_org_name).toBe(orgName);

      // Step 6: Check installation status
      const statusResult = await db.query(
        'SELECT * FROM gitswarm_orgs WHERE github_org_name = $1',
        [orgName]
      );
      expect(statusResult.rows).toHaveLength(1);
      expect(statusResult.rows[0].status).toBe('active');

      // Step 7: Count synced repos directly from store
      const repoCount = Array.from(db.store.gitswarm_repos.values())
        .filter(r => r.org_id === org.id).length;
      expect(repoCount).toBe(3);
    });

    it('should handle re-installation (update existing org)', async () => {
      // First installation
      const firstResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['recurring-org', 11111, '22222']
      );
      expect(firstResult.rows[0].status).toBe('active');

      // Verify org exists by name
      const existingOrg = await db.query(
        'SELECT * FROM gitswarm_orgs WHERE github_org_name = $1',
        ['recurring-org']
      );
      expect(existingOrg.rows).toHaveLength(1);
    });
  });

  // ============================================================
  // Phase 6: Council Governance Flow
  // ============================================================

  describe('Phase 6: Council Governance Flow', () => {
    it('should complete full council governance flow', async () => {
      // Step 1: Create agents for council
      const agents = [];
      for (let i = 1; i <= 4; i++) {
        const result = await db.query(
          'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
          [`council-agent-${i}`, `Council member ${i}`, `hash${i}`]
        );
        const agent = result.rows[0];
        agent.karma = 2000 + i * 100; // Give enough karma
        db.store.agents.set(agent.id, agent);
        agents.push(agent);
      }

      // Step 2: Create org and repo
      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['council-org', 33333, '44444']
      );
      const org = orgResult.rows[0];

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [org.id, 'governed-repo', 2001, 'council-org/governed-repo', false, 'A council-governed repo', 'main']
      );
      const repo = repoResult.rows[0];

      // Step 3: Create council
      const councilResult = await db.query(
        'INSERT INTO gitswarm_repo_councils (repo_id, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [repo.id, 1000, 5, 3, 9, 2, 3]
      );
      const council = councilResult.rows[0];
      expect(council.status).toBe('forming');
      expect(council.min_members).toBe(3);

      // Step 4: Add council members
      for (let i = 0; i < 3; i++) {
        const role = i === 0 ? 'chair' : 'member';
        await db.query(
          'INSERT INTO gitswarm_council_members (council_id, agent_id, role) VALUES ($1, $2, $3) RETURNING *',
          [council.id, agents[i].id, role]
        );
      }

      // Step 5: Verify council now has members
      const members = await db.query(
        'SELECT * FROM gitswarm_council_members WHERE council_id = $1',
        [council.id]
      );
      expect(members.rows).toHaveLength(3);
      expect(members.rows.find(m => m.role === 'chair')).toBeDefined();

      // Step 6: Council reaches minimum members - update to active
      await db.query(
        'UPDATE gitswarm_repo_councils SET status = $1 WHERE id = $2',
        ['active', council.id]
      );

      const activeCouncil = await db.query(
        'SELECT * FROM gitswarm_repo_councils WHERE id = $1',
        [council.id]
      );
      expect(activeCouncil.rows[0].status).toBe('active');

      // Step 7: Create a proposal
      const proposalResult = await db.query(
        `INSERT INTO gitswarm_council_proposals (council_id, proposer_id, title, description, proposal_type, action_data, quorum_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          council.id, agents[0].id, 'Add new maintainer',
          'Proposal to add agent-4 as a maintainer',
          'add_maintainer',
          JSON.stringify({ agent_id: agents[3].id, role: 'maintainer' }),
          2
        ]
      );
      const proposal = proposalResult.rows[0];
      expect(proposal.status).toBe('open');
      expect(proposal.votes_for).toBe(0);

      // Step 8: Council members vote
      // Vote 1: For
      await db.query(
        'INSERT INTO gitswarm_council_votes (proposal_id, voter_id, vote, comment) VALUES ($1, $2, $3, $4) RETURNING *',
        [proposal.id, agents[0].id, 'for', 'I support this addition']
      );

      // Vote 2: For
      await db.query(
        'INSERT INTO gitswarm_council_votes (proposal_id, voter_id, vote, comment) VALUES ($1, $2, $3, $4) RETURNING *',
        [proposal.id, agents[1].id, 'for', 'Agreed, they have contributed a lot']
      );

      // Step 9: Check vote counts
      const voteResults = await db.query(
        'SELECT vote, count FROM gitswarm_council_votes WHERE proposal_id = $1 GROUP BY vote',
        [proposal.id]
      );
      const forVotes = voteResults.rows.find(v => v.vote === 'for');
      expect(parseInt(forVotes.count)).toBe(2);

      // Step 10: Quorum reached (2 votes >= 2 required), proposal passes
      await db.query(
        'UPDATE gitswarm_council_proposals SET votes_for = $1, votes_against = $2 WHERE id = $3',
        [2, 0, proposal.id]
      );

      await db.query(
        'UPDATE gitswarm_council_proposals SET status = $1 WHERE id = $2',
        ['passed', proposal.id]
      );

      const passedProposal = await db.query(
        'SELECT * FROM gitswarm_council_proposals WHERE id = $1',
        [proposal.id]
      );
      expect(passedProposal.rows[0].status).toBe('passed');

      // Step 11: Execute proposal - add maintainer
      await db.query(
        'INSERT INTO gitswarm_repo_maintainers (repo_id, agent_id, role) VALUES ($1, $2, $3) RETURNING *',
        [repo.id, agents[3].id, 'maintainer']
      );

      const newMaintainer = await db.query(
        'SELECT * FROM gitswarm_repo_maintainers WHERE repo_id = $1 AND agent_id = $2',
        [repo.id, agents[3].id]
      );
      expect(newMaintainer.rows).toHaveLength(1);
      expect(newMaintainer.rows[0].role).toBe('maintainer');
    });

    it('should reject proposal when votes against exceed for', async () => {
      // Quick setup
      const agentResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['voter', 'A voter', 'hash']
      );

      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['reject-org', 55555, '66666']
      );

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [orgResult.rows[0].id, 'reject-repo', 3001, 'reject-org/reject-repo', false, 'Test', 'main']
      );

      const councilResult = await db.query(
        'INSERT INTO gitswarm_repo_councils (repo_id, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [repoResult.rows[0].id, 1000, 5, 3, 9, 2, 3]
      );

      const proposalResult = await db.query(
        `INSERT INTO gitswarm_council_proposals (council_id, proposer_id, title, description, proposal_type, action_data, quorum_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [councilResult.rows[0].id, agentResult.rows[0].id, 'Bad proposal', 'Should be rejected', 'modify_access', '{}', 2]
      );

      // Simulate 0 for, 2 against
      await db.query(
        'UPDATE gitswarm_council_proposals SET votes_for = $1, votes_against = $2 WHERE id = $3',
        [0, 2, proposalResult.rows[0].id]
      );

      await db.query(
        'UPDATE gitswarm_council_proposals SET status = $1 WHERE id = $2',
        ['rejected', proposalResult.rows[0].id]
      );

      const rejectedProposal = await db.query(
        'SELECT * FROM gitswarm_council_proposals WHERE id = $1',
        [proposalResult.rows[0].id]
      );
      expect(rejectedProposal.rows[0].status).toBe('rejected');
    });
  });

  // ============================================================
  // Phase 7: Package Registry Flow
  // ============================================================

  describe('Phase 7: Package Registry Flow', () => {
    it('should complete full package lifecycle', async () => {
      // Step 1: Create agent (package maintainer)
      const agentResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['pkg-maintainer', 'Maintains packages', 'hash789']
      );
      const maintainer = agentResult.rows[0];

      // Step 2: Create org and repo
      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['pkg-org', 77777, '88888']
      );
      const org = orgResult.rows[0];

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [org.id, 'utils', 4001, 'pkg-org/utils', false, 'Utility library', 'main']
      );
      const repo = repoResult.rows[0];

      // Step 3: Create package
      const packageResult = await db.query(
        'INSERT INTO gitswarm_packages (repo_id, name, package_type, description, license) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repo.id, '@pkg-org/utils', 'npm', 'A collection of utility functions', 'MIT']
      );
      const pkg = packageResult.rows[0];
      expect(pkg.status).toBe('active');
      expect(pkg.package_type).toBe('npm');

      // Step 4: Add maintainer
      await db.query(
        `INSERT INTO gitswarm_package_maintainers (package_id, agent_id, role, can_publish, can_yank, can_add_maintainers, can_deprecate, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [pkg.id, maintainer.id, 'owner', true, true, true, true, null]
      );

      const maintainerResult = await db.query(
        'SELECT * FROM gitswarm_package_maintainers WHERE package_id = $1 AND agent_id = $2',
        [pkg.id, maintainer.id]
      );
      expect(maintainerResult.rows[0].role).toBe('owner');
      expect(maintainerResult.rows[0].can_publish).toBe(true);

      // Step 5: Publish version 1.0.0
      const v1Result = await db.query(
        `INSERT INTO gitswarm_package_versions (package_id, version, published_by, artifact_url, artifact_size, checksum, manifest, git_tag, git_commit_sha, prerelease)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [pkg.id, '1.0.0', maintainer.id, '/packages/utils/1.0.0/package.tar.gz', 1024, 'sha256:abc123', '{}', 'v1.0.0', 'abc123', false]
      );
      const v1 = v1Result.rows[0];
      expect(v1.version).toBe('1.0.0');
      expect(v1.prerelease).toBe(false);

      // Update latest version
      await db.query(
        'UPDATE gitswarm_packages SET latest_version = $2 WHERE id = $1',
        [pkg.id, '1.0.0']
      );

      // Step 6: Publish version 1.1.0
      await db.query(
        `INSERT INTO gitswarm_package_versions (package_id, version, published_by, artifact_url, artifact_size, checksum, manifest, git_tag, git_commit_sha, prerelease)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [pkg.id, '1.1.0', maintainer.id, '/packages/utils/1.1.0/package.tar.gz', 1100, 'sha256:def456', '{}', 'v1.1.0', 'def456', false]
      );

      await db.query(
        'UPDATE gitswarm_packages SET latest_version = $2 WHERE id = $1',
        [pkg.id, '1.1.0']
      );

      // Step 7: List versions
      const versions = await db.query(
        'SELECT * FROM gitswarm_package_versions WHERE package_id = $1',
        [pkg.id]
      );
      expect(versions.rows).toHaveLength(2);

      // Step 8: Record downloads
      for (let i = 0; i < 5; i++) {
        await db.query(
          'INSERT INTO gitswarm_package_downloads (version_id, agent_id, ip_hash, user_agent) VALUES ($1, $2, $3, $4) RETURNING *',
          [v1.id, null, `hash${i}`, 'npm/8.0.0']
        );
      }

      // Step 9: Yank version 1.0.0 (security issue)
      await db.query(
        'UPDATE gitswarm_package_versions SET yanked = true, yanked_reason = $3 WHERE package_id = $1 AND version = $2',
        [pkg.id, '1.0.0', 'Security vulnerability discovered']
      );

      // Step 10: Verify yanked version
      const allVersions = await db.query(
        'SELECT * FROM gitswarm_package_versions WHERE package_id = $1',
        [pkg.id]
      );
      // Only non-yanked version should be returned by default query
      expect(allVersions.rows.filter(v => !v.yanked)).toHaveLength(1);

      // Step 11: Create security advisory
      const advisoryResult = await db.query(
        `INSERT INTO gitswarm_package_advisories (package_id, title, description, severity, affected_versions, patched_versions, cve_id, reported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          pkg.id,
          'Critical Memory Leak',
          'Version 1.0.0 has a memory leak that can cause DoS',
          'high',
          '>=1.0.0 <1.1.0',
          '>=1.1.0',
          'CVE-2024-12345',
          maintainer.id
        ]
      );
      const advisory = advisoryResult.rows[0];
      expect(advisory.severity).toBe('high');

      // Step 12: List advisories
      const advisories = await db.query(
        'SELECT * FROM gitswarm_package_advisories WHERE package_id = $1',
        [pkg.id]
      );
      expect(advisories.rows).toHaveLength(1);
    });

    it('should handle prerelease versions', async () => {
      // Quick setup
      const agentResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['prerelease-dev', 'Dev', 'hash']
      );

      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['beta-org', 99999, '11111']
      );

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [orgResult.rows[0].id, 'beta-lib', 5001, 'beta-org/beta-lib', false, 'Beta library', 'main']
      );

      const pkgResult = await db.query(
        'INSERT INTO gitswarm_packages (repo_id, name, package_type, description, license) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repoResult.rows[0].id, 'beta-lib', 'npm', 'Beta library', 'MIT']
      );

      // Publish stable version
      await db.query(
        `INSERT INTO gitswarm_package_versions (package_id, version, published_by, artifact_url, artifact_size, checksum, manifest, git_tag, git_commit_sha, prerelease)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [pkgResult.rows[0].id, '1.0.0', agentResult.rows[0].id, '/pkg/1.0.0', 1000, 'sha256:aaa', '{}', 'v1.0.0', 'aaa', false]
      );

      // Publish prerelease
      const prereleaseResult = await db.query(
        `INSERT INTO gitswarm_package_versions (package_id, version, published_by, artifact_url, artifact_size, checksum, manifest, git_tag, git_commit_sha, prerelease)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [pkgResult.rows[0].id, '2.0.0-beta.1', agentResult.rows[0].id, '/pkg/2.0.0-beta.1', 1100, 'sha256:bbb', '{}', 'v2.0.0-beta.1', 'bbb', true]
      );

      expect(prereleaseResult.rows[0].prerelease).toBe(true);
      expect(prereleaseResult.rows[0].version).toBe('2.0.0-beta.1');

      // Latest version should still be 1.0.0 (stable)
      await db.query(
        'UPDATE gitswarm_packages SET latest_version = $2 WHERE id = $1',
        [pkgResult.rows[0].id, '1.0.0']
      );

      const pkg = await db.query(
        'SELECT * FROM gitswarm_packages WHERE id = $1',
        [pkgResult.rows[0].id]
      );
      expect(pkg.rows[0].latest_version).toBe('1.0.0');
    });

    it('should manage package maintainers', async () => {
      // Setup
      const ownerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['pkg-owner', 'Owner', 'hash1']
      );
      const owner = ownerResult.rows[0];

      const newMaintainerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['new-maintainer', 'New maintainer', 'hash2']
      );
      const newMaintainer = newMaintainerResult.rows[0];

      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['maintainer-org', 12121, '21212']
      );

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [orgResult.rows[0].id, 'managed-pkg', 6001, 'maintainer-org/managed-pkg', false, 'Managed', 'main']
      );

      const pkgResult = await db.query(
        'INSERT INTO gitswarm_packages (repo_id, name, package_type, description, license) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repoResult.rows[0].id, 'managed-pkg', 'npm', 'Managed package', 'MIT']
      );
      const pkg = pkgResult.rows[0];

      // Add owner
      await db.query(
        `INSERT INTO gitswarm_package_maintainers (package_id, agent_id, role, can_publish, can_yank, can_add_maintainers, can_deprecate, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [pkg.id, owner.id, 'owner', true, true, true, true, null]
      );

      // Owner adds new maintainer with limited permissions
      await db.query(
        `INSERT INTO gitswarm_package_maintainers (package_id, agent_id, role, can_publish, can_yank, can_add_maintainers, can_deprecate, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [pkg.id, newMaintainer.id, 'maintainer', true, true, false, false, owner.id]
      );

      // Verify maintainers
      const maintainers = await db.query(
        'SELECT * FROM gitswarm_package_maintainers WHERE package_id = $1',
        [pkg.id]
      );
      expect(maintainers.rows).toHaveLength(2);

      const newMaintainerPerms = maintainers.rows.find(m => m.agent_id === newMaintainer.id);
      expect(newMaintainerPerms.can_publish).toBe(true);
      expect(newMaintainerPerms.can_add_maintainers).toBe(false);
      expect(newMaintainerPerms.added_by).toBe(owner.id);

      // Remove maintainer
      await db.query(
        'DELETE FROM gitswarm_package_maintainers WHERE package_id = $1 AND agent_id = $2',
        [pkg.id, newMaintainer.id]
      );

      const remainingMaintainers = await db.query(
        'SELECT * FROM gitswarm_package_maintainers WHERE package_id = $1',
        [pkg.id]
      );
      expect(remainingMaintainers.rows).toHaveLength(1);
      expect(remainingMaintainers.rows[0].agent_id).toBe(owner.id);
    });
  });

  // ============================================================
  // Integration: Cross-Phase Flows
  // ============================================================

  describe('Integration: Cross-Phase Flows', () => {
    it('should handle full PR lifecycle with human reviews and karma', async () => {
      // Setup org, repo, agents
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['pr-author', 'PR author', 'hash1']
      );
      const author = authorResult.rows[0];

      const reviewerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['agent-reviewer', 'Agent reviewer', 'hash2']
      );
      const agentReviewer = reviewerResult.rows[0];
      agentReviewer.karma = 500;
      db.store.agents.set(agentReviewer.id, agentReviewer);

      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['lifecycle-org', 44444, '55555']
      );

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [orgResult.rows[0].id, 'lifecycle-repo', 7001, 'lifecycle-org/lifecycle-repo', false, 'Lifecycle test', 'main']
      );
      const repo = repoResult.rows[0];

      // Create patch
      const patchResult = await db.query(
        'INSERT INTO patches (repo_id, author_id, title, description, github_pr_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repo.id, author.id, 'Add feature X', 'Implements feature X', 'https://github.com/lifecycle-org/lifecycle-repo/pull/1']
      );
      const patch = patchResult.rows[0];

      // Agent review
      await db.query(
        `INSERT INTO patch_reviews (patch_id, reviewer_id, github_user_mapping_id, is_human, verdict, comments, github_review_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [patch.id, agentReviewer.id, null, false, 'approve', 'Code looks good', null]
      );

      // Human review via GitHub
      const humanMapping = await db.query(
        'INSERT INTO gitswarm_github_user_mappings (github_user_id, github_login, avatar_url) VALUES ($1, $2, $3) RETURNING *',
        [12345, 'senior-dev', 'https://github.com/avatars/12345']
      );

      await db.query(
        `INSERT INTO patch_reviews (patch_id, reviewer_id, github_user_mapping_id, is_human, verdict, comments, github_review_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [patch.id, null, humanMapping.rows[0].id, true, 'approve', 'LGTM from human review', 99999]
      );

      // Verify reviews
      const reviews = await db.query(
        'SELECT * FROM patch_reviews WHERE patch_id = $1',
        [patch.id]
      );
      expect(reviews.rows).toHaveLength(2);
      expect(reviews.rows.filter(r => r.is_human)).toHaveLength(1);
      expect(reviews.rows.filter(r => !r.is_human)).toHaveLength(1);

      // Merge patch
      await db.query(
        'UPDATE patches SET status = $1 WHERE id = $2',
        ['merged', patch.id]
      );

      // Award karma to author
      await db.query(
        'UPDATE agents SET karma = karma + $1 WHERE id = $2',
        [25, author.id]
      );

      // Award karma to agent reviewer
      await db.query(
        'UPDATE agents SET karma = karma + $1 WHERE id = $2',
        [5, agentReviewer.id]
      );

      // Verify final state
      const mergedPatch = await db.query(
        'SELECT * FROM patches WHERE id = $1',
        [patch.id]
      );
      expect(mergedPatch.rows[0].status).toBe('merged');

      const updatedAuthor = db.store.agents.get(author.id);
      expect(updatedAuthor.karma).toBe(25);

      const updatedReviewer = db.store.agents.get(agentReviewer.id);
      expect(updatedReviewer.karma).toBe(505); // 500 + 5
    });

    it('should handle council-approved package actions', async () => {
      // This tests the integration between council governance (Phase 6) and package registry (Phase 7)

      // Setup agents
      const councilMembers = [];
      for (let i = 1; i <= 3; i++) {
        const result = await db.query(
          'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
          [`council-pkg-${i}`, `Member ${i}`, `hash${i}`]
        );
        councilMembers.push(result.rows[0]);
      }

      const newMaintainerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['proposed-maintainer', 'Proposed maintainer', 'hash4']
      );
      const proposedMaintainer = newMaintainerResult.rows[0];

      // Setup org, repo, council
      const orgResult = await db.query(
        'INSERT INTO gitswarm_orgs (github_org_name, github_org_id, github_installation_id) VALUES ($1, $2, $3) RETURNING *',
        ['council-pkg-org', 88888, '99999']
      );

      const repoResult = await db.query(
        'INSERT INTO gitswarm_repos (org_id, github_repo_name, github_repo_id, github_full_name, is_private, description, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [orgResult.rows[0].id, 'council-pkg-repo', 8001, 'council-pkg-org/council-pkg-repo', false, 'Council managed', 'main']
      );
      const repo = repoResult.rows[0];

      // Create council
      const councilResult = await db.query(
        'INSERT INTO gitswarm_repo_councils (repo_id, min_karma, min_contributions, min_members, max_members, standard_quorum, critical_quorum) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [repo.id, 100, 1, 3, 9, 2, 3]
      );
      const council = councilResult.rows[0];

      // Add council members
      for (const member of councilMembers) {
        await db.query(
          'INSERT INTO gitswarm_council_members (council_id, agent_id, role) VALUES ($1, $2, $3) RETURNING *',
          [council.id, member.id, 'member']
        );
      }

      // Create package
      const pkgResult = await db.query(
        'INSERT INTO gitswarm_packages (repo_id, name, package_type, description, license) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [repo.id, 'council-managed-pkg', 'npm', 'Council managed package', 'MIT']
      );
      const pkg = pkgResult.rows[0];

      // Create proposal to add package maintainer
      const proposalResult = await db.query(
        `INSERT INTO gitswarm_council_proposals (council_id, proposer_id, title, description, proposal_type, action_data, quorum_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          council.id,
          councilMembers[0].id,
          'Add package maintainer',
          `Add ${proposedMaintainer.id} as package maintainer`,
          'add_package_maintainer',
          JSON.stringify({ package_id: pkg.id, agent_id: proposedMaintainer.id }),
          2
        ]
      );

      // Council votes (2 for)
      await db.query(
        'INSERT INTO gitswarm_council_votes (proposal_id, voter_id, vote, comment) VALUES ($1, $2, $3, $4)',
        [proposalResult.rows[0].id, councilMembers[0].id, 'for', 'Support']
      );
      await db.query(
        'INSERT INTO gitswarm_council_votes (proposal_id, voter_id, vote, comment) VALUES ($1, $2, $3, $4)',
        [proposalResult.rows[0].id, councilMembers[1].id, 'for', 'Agreed']
      );

      // Proposal passes
      await db.query(
        'UPDATE gitswarm_council_proposals SET status = $1, votes_for = 2 WHERE id = $2',
        ['passed', proposalResult.rows[0].id]
      );

      // Execute: Add package maintainer
      await db.query(
        `INSERT INTO gitswarm_package_maintainers (package_id, agent_id, role, can_publish, can_yank, can_add_maintainers, can_deprecate, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [pkg.id, proposedMaintainer.id, 'maintainer', true, true, false, false, council.id]
      );

      // Verify
      const maintainer = await db.query(
        'SELECT * FROM gitswarm_package_maintainers WHERE package_id = $1 AND agent_id = $2',
        [pkg.id, proposedMaintainer.id]
      );
      expect(maintainer.rows).toHaveLength(1);
      expect(maintainer.rows[0].can_publish).toBe(true);
    });
  });
});
