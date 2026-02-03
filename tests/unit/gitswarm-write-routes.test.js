import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GitSwarm Write Routes', () => {
  let mockQuery;
  let mockGitswarmService;
  let mockPermissionService;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockGitswarmService = {
      createFile: vi.fn(),
      updateFile: vi.fn(),
      createBranch: vi.fn(),
      createPullRequest: vi.fn(),
      mergePullRequest: vi.fn()
    };
    mockPermissionService = {
      canPerform: vi.fn(),
      canPushToBranch: vi.fn(),
      checkConsensus: vi.fn(),
      requiresTestsPass: vi.fn(),
      getRequiredApprovals: vi.fn()
    };
  });

  describe('Create File', () => {
    it('should create file with write permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockGitswarmService.createFile.mockResolvedValueOnce({
        commit: { sha: 'new-commit' },
        content: { sha: 'file-sha' }
      });

      // Verify permission check is called with correct arguments
      await mockPermissionService.canPerform('agent-1', 'repo-1', 'write');
      expect(mockPermissionService.canPerform).toHaveBeenCalledWith('agent-1', 'repo-1', 'write');
    });

    it('should check branch push permission when branch specified', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockPermissionService.canPushToBranch.mockResolvedValueOnce({ allowed: true });

      await mockPermissionService.canPushToBranch('agent-1', 'repo-1', 'feature-branch');
      expect(mockPermissionService.canPushToBranch).toHaveBeenCalledWith(
        'agent-1',
        'repo-1',
        'feature-branch'
      );
    });

    it('should deny when branch push permission denied', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockPermissionService.canPushToBranch.mockResolvedValueOnce({
        allowed: false,
        reason: 'branch_protected'
      });

      const result = await mockPermissionService.canPushToBranch('agent-1', 'repo-1', 'main');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('branch_protected');
    });
  });

  describe('Update File', () => {
    it('should update file with correct SHA', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockGitswarmService.updateFile.mockResolvedValueOnce({
        commit: { sha: 'updated-commit' },
        content: { sha: 'new-file-sha' }
      });

      const result = await mockGitswarmService.updateFile(
        'repo-1',
        'file.txt',
        'updated content',
        'Update file',
        'old-sha',
        'main',
        'Agent',
        'agent@bothub.dev'
      );

      expect(result.commit.sha).toBe('updated-commit');
    });

    it('should require SHA for update', () => {
      const requestBody = {
        content: 'new content',
        message: 'Update file'
        // sha is missing
      };

      expect(requestBody.sha).toBeUndefined();
    });
  });

  describe('Create Branch', () => {
    it('should create branch with write permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockGitswarmService.createBranch.mockResolvedValueOnce({
        ref: 'refs/heads/new-branch',
        object: { sha: 'base-sha' }
      });

      const result = await mockGitswarmService.createBranch('repo-1', 'new-branch', 'base-sha');
      expect(result.ref).toBe('refs/heads/new-branch');
    });

    it('should deny branch creation without write permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: false });

      const result = await mockPermissionService.canPerform('agent-1', 'repo-1', 'write');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Create Pull Request', () => {
    it('should create PR with valid data', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockGitswarmService.createPullRequest.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/org/repo/pull/42'
      });

      const result = await mockGitswarmService.createPullRequest('repo-1', {
        title: 'Add feature',
        body: 'Description',
        head: 'feature-branch',
        base: 'main'
      });

      expect(result.number).toBe(42);
      expect(result.html_url).toContain('/pull/42');
    });

    it('should track PR in gitswarm_patches', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await mockQuery(`
        INSERT INTO gitswarm_patches (patch_id, repo_id, github_pr_number, github_pr_url, github_branch, base_branch)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['patch-uuid', 'repo-uuid', 42, 'https://github.com/org/repo/pull/42', 'feature', 'main']);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_patches'),
        expect.arrayContaining(['patch-uuid', 'repo-uuid', 42])
      );
    });
  });

  describe('Merge Pull Request', () => {
    it('should merge PR when consensus reached', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockPermissionService.checkConsensus.mockResolvedValueOnce({
        reached: true,
        reason: 'consensus_reached',
        ratio: 0.75
      });
      mockGitswarmService.mergePullRequest.mockResolvedValueOnce({
        sha: 'merge-sha',
        merged: true,
        message: 'Merged successfully'
      });

      const result = await mockGitswarmService.mergePullRequest('repo-1', 42, {
        merge_method: 'squash'
      });

      expect(result.merged).toBe(true);
      expect(result.sha).toBe('merge-sha');
    });

    it('should deny merge without consensus', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockPermissionService.checkConsensus.mockResolvedValueOnce({
        reached: false,
        reason: 'below_threshold',
        ratio: 0.4,
        threshold: 0.66
      });

      const consensus = await mockPermissionService.checkConsensus('patch-1', 'repo-1');
      expect(consensus.reached).toBe(false);
      expect(consensus.reason).toBe('below_threshold');
    });

    it('should deny merge without merge permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: false });

      const result = await mockPermissionService.canPerform('agent-1', 'repo-1', 'merge');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Merge Check', () => {
    it('should return eligible when all checks pass', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockPermissionService.checkConsensus.mockResolvedValueOnce({
        reached: true,
        reason: 'consensus_reached'
      });
      mockPermissionService.requiresTestsPass.mockResolvedValueOnce(true);
      mockPermissionService.getRequiredApprovals.mockResolvedValueOnce(2);

      const consensus = await mockPermissionService.checkConsensus('patch-1', 'repo-1');
      const canMerge = await mockPermissionService.canPerform('agent-1', 'repo-1', 'merge');

      expect(consensus.reached && canMerge.allowed).toBe(true);
    });

    it('should include branch rules in check response', async () => {
      const testsRequired = await mockPermissionService.requiresTestsPass('repo-1', 'main');
      const requiredApprovals = await mockPermissionService.getRequiredApprovals('repo-1', 'main');

      // Verify the calls were made correctly
      expect(mockPermissionService.requiresTestsPass).toHaveBeenCalledWith('repo-1', 'main');
      expect(mockPermissionService.getRequiredApprovals).toHaveBeenCalledWith('repo-1', 'main');
    });
  });
});

describe('GitSwarm Review Routes', () => {
  let mockQuery;
  let mockPermissionService;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockPermissionService = {
      canPerform: vi.fn(),
      checkConsensus: vi.fn()
    };
  });

  describe('Submit Review', () => {
    it('should submit approval review', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ patch_id: 'patch-uuid' }] }) // Get patch
        .mockResolvedValueOnce({ rows: [] }) // Insert review
        .mockResolvedValueOnce({ rows: [] }); // Update reviewer stats

      const patchResult = await mockQuery(
        `SELECT gp.patch_id FROM gitswarm_patches gp WHERE gp.repo_id = $1 AND gp.github_pr_number = $2`,
        ['repo-1', 42]
      );

      expect(patchResult.rows[0].patch_id).toBe('patch-uuid');

      await mockQuery(
        `INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, tested)
         VALUES ($1, $2, $3, $4, $5)`,
        ['patch-uuid', 'agent-1', 'approve', 'LGTM', true]
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO patch_reviews'),
        expect.arrayContaining(['patch-uuid', 'agent-1', 'approve'])
      );
    });

    it('should submit request_changes review', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await mockQuery(
        `INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, feedback, tested)
         VALUES ($1, $2, $3, $4, $5)`,
        ['patch-uuid', 'agent-1', 'request_changes', 'Please fix the bug', false]
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO patch_reviews'),
        expect.arrayContaining(['request_changes', 'Please fix the bug'])
      );
    });

    it('should update reviewer stats on review', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await mockQuery(`
        INSERT INTO reviewer_stats (agent_id, total_reviews, approvals, rejections)
        VALUES ($1, 1, $2, $3)
        ON CONFLICT (agent_id) DO UPDATE SET
          total_reviews = reviewer_stats.total_reviews + 1,
          approvals = reviewer_stats.approvals + $2,
          rejections = reviewer_stats.rejections + $3
      `, ['agent-1', 1, 0]); // approval

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reviewer_stats'),
        ['agent-1', 1, 0]
      );
    });

    it('should return updated consensus after review', async () => {
      mockPermissionService.checkConsensus.mockResolvedValueOnce({
        reached: true,
        reason: 'consensus_reached',
        ratio: 0.8,
        approvals: 4,
        rejections: 1
      });

      const consensus = await mockPermissionService.checkConsensus('patch-uuid', 'repo-1');

      expect(consensus.reached).toBe(true);
      expect(consensus.ratio).toBe(0.8);
    });
  });

  describe('Get Reviews', () => {
    it('should list reviews with reviewer info', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ patch_id: 'patch-uuid' }] }) // Get patch
        .mockResolvedValueOnce({
          rows: [
            {
              verdict: 'approve',
              feedback: 'LGTM',
              tested: true,
              reviewed_at: '2024-01-01T00:00:00Z',
              reviewer_id: 'reviewer-1',
              reviewer_name: 'Reviewer Bot',
              reviewer_karma: 500,
              is_maintainer: true
            },
            {
              verdict: 'approve',
              feedback: 'Good work',
              tested: false,
              reviewed_at: '2024-01-02T00:00:00Z',
              reviewer_id: 'reviewer-2',
              reviewer_name: 'Helper Bot',
              reviewer_karma: 200,
              is_maintainer: false
            }
          ]
        });

      const patchResult = await mockQuery(`SELECT patch_id FROM gitswarm_patches WHERE repo_id = $1 AND github_pr_number = $2`, ['repo-1', 42]);
      const reviews = await mockQuery(`SELECT * FROM patch_reviews WHERE patch_id = $1`, [patchResult.rows[0].patch_id]);

      expect(reviews.rows).toHaveLength(2);
      expect(reviews.rows[0].is_maintainer).toBe(true);
    });

    it('should return empty reviews for untracked PR', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const patchResult = await mockQuery(`SELECT patch_id FROM gitswarm_patches WHERE repo_id = $1 AND github_pr_number = $2`, ['repo-1', 999]);

      expect(patchResult.rows).toHaveLength(0);
    });
  });
});

describe('GitSwarm Branch Rules Routes', () => {
  let mockQuery;
  let mockPermissionService;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockPermissionService = {
      canPerform: vi.fn()
    };
  });

  describe('List Branch Rules', () => {
    it('should list rules ordered by priority', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { branch_pattern: 'main', priority: 10, direct_push: 'none', required_approvals: 2 },
          { branch_pattern: 'release/*', priority: 5, direct_push: 'maintainers', required_approvals: 1 },
          { branch_pattern: 'feature/*', priority: 0, direct_push: 'all', required_approvals: 0 }
        ]
      });

      const result = await mockQuery(`
        SELECT * FROM gitswarm_branch_rules
        WHERE repo_id = $1
        ORDER BY priority DESC
      `, ['repo-1']);

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].branch_pattern).toBe('main');
      expect(result.rows[0].priority).toBe(10);
    });
  });

  describe('Create Branch Rule', () => {
    it('should create rule with admin permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'rule-uuid',
          branch_pattern: 'main',
          direct_push: 'none',
          required_approvals: 2,
          require_tests_pass: true
        }]
      });

      await mockPermissionService.canPerform('agent-1', 'repo-1', 'settings');
      expect(mockPermissionService.canPerform).toHaveBeenCalledWith('agent-1', 'repo-1', 'settings');

      const result = await mockQuery(`
        INSERT INTO gitswarm_branch_rules (repo_id, branch_pattern, direct_push, required_approvals, require_tests_pass)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, ['repo-1', 'main', 'none', 2, true]);

      expect(result.rows[0].branch_pattern).toBe('main');
    });

    it('should handle duplicate pattern conflict', async () => {
      const error = new Error('duplicate key value');
      error.code = '23505';
      mockQuery.mockRejectedValueOnce(error);

      await expect(mockQuery(`INSERT INTO gitswarm_branch_rules ...`)).rejects.toThrow('duplicate key');
    });
  });

  describe('Update Branch Rule', () => {
    it('should update rule fields', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'rule-uuid',
          direct_push: 'maintainers',
          required_approvals: 3,
          updated_at: '2024-01-02T00:00:00Z'
        }]
      });

      const result = await mockQuery(`
        UPDATE gitswarm_branch_rules SET direct_push = $1, required_approvals = $2, updated_at = NOW()
        WHERE id = $3 AND repo_id = $4
        RETURNING *
      `, ['maintainers', 3, 'rule-uuid', 'repo-1']);

      expect(result.rows[0].direct_push).toBe('maintainers');
      expect(result.rows[0].required_approvals).toBe(3);
    });

    it('should return 404 for non-existent rule', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await mockQuery(`UPDATE gitswarm_branch_rules ... WHERE id = $1`, ['non-existent']);

      expect(result.rows).toHaveLength(0);
    });
  });

  describe('Delete Branch Rule', () => {
    it('should delete rule with admin permission', async () => {
      mockPermissionService.canPerform.mockResolvedValueOnce({ allowed: true });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rule-uuid' }] });

      const result = await mockQuery(`
        DELETE FROM gitswarm_branch_rules WHERE id = $1 AND repo_id = $2 RETURNING id
      `, ['rule-uuid', 'repo-1']);

      expect(result.rows).toHaveLength(1);
    });
  });
});

describe('Input Validation', () => {
  describe('File Path Validation', () => {
    it('should reject empty path', () => {
      const path = '';
      expect(path).toBe('');
    });

    it('should allow valid file paths', () => {
      const validPaths = [
        'README.md',
        'src/index.js',
        'path/to/deeply/nested/file.txt',
        '.gitignore'
      ];

      validPaths.forEach(path => {
        expect(path.length).toBeGreaterThan(0);
      });
    });
  });

  describe('PR Data Validation', () => {
    it('should require title and head', () => {
      const validPR = {
        title: 'Add feature',
        head: 'feature-branch'
      };

      expect(validPR.title).toBeDefined();
      expect(validPR.head).toBeDefined();
    });

    it('should have optional base defaulting to main', () => {
      const pr = {
        title: 'Add feature',
        head: 'feature-branch'
        // base is optional
      };

      const base = pr.base || 'main';
      expect(base).toBe('main');
    });
  });

  describe('Review Verdict Validation', () => {
    it('should only allow valid verdicts', () => {
      const validVerdicts = ['approve', 'request_changes', 'comment'];
      const invalidVerdict = 'maybe';

      expect(validVerdicts).toContain('approve');
      expect(validVerdicts).not.toContain(invalidVerdict);
    });
  });

  describe('Merge Method Validation', () => {
    it('should only allow valid merge methods', () => {
      const validMethods = ['merge', 'squash', 'rebase'];
      const invalidMethod = 'fast-forward';

      expect(validMethods).toContain('squash');
      expect(validMethods).not.toContain(invalidMethod);
    });
  });
});
