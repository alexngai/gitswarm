import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitSwarmPermissionService } from '../../src/services/gitswarm-permissions.js';

describe('GitSwarmPermissionService', () => {
  let service;
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
    service = new GitSwarmPermissionService({ query: mockQuery });
  });

  describe('resolvePermissions', () => {
    const agentId = 'agent-123';
    const repoId = 'repo-456';

    it('should return explicit access when agent has direct permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ access_level: 'write', expires_at: null }]
      });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('write');
      expect(result.source).toBe('explicit');
    });

    it('should handle expired explicit access', async () => {
      const expiredDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ access_level: 'write', expires_at: expiredDate }]
        })
        .mockResolvedValueOnce({ rows: [] }) // DELETE query
        .mockResolvedValueOnce({ rows: [] }) // maintainer check
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'none',
            min_karma: 0,
            is_private: true,
            ownership_model: 'open',
            default_agent_access: 'none',
            default_min_karma: 0,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 0 }] }); // agent karma

      const result = await service.resolvePermissions(agentId, repoId);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM gitswarm_repo_access'),
        [repoId, agentId]
      );
      expect(result.level).toBe('none');
    });

    it('should return maintainer access for owner role', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // No explicit access
        .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // Maintainer with owner role

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('admin');
      expect(result.source).toBe('maintainer');
      expect(result.role).toBe('owner');
    });

    it('should return maintain access for maintainer role', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('maintain');
      expect(result.source).toBe('maintainer');
    });

    it('should return write access for public repos', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'public',
            min_karma: 0,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'public',
            default_min_karma: 0,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 100 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('write');
      expect(result.source).toBe('public');
    });

    it('should handle karma_threshold access mode with sufficient karma', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'karma_threshold',
            min_karma: 100,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'karma_threshold',
            default_min_karma: 100,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 150 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('write');
      expect(result.source).toBe('karma');
      expect(result.karma).toBe(150);
      expect(result.threshold).toBe(100);
    });

    it('should return read access for karma below threshold on public repo', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'karma_threshold',
            min_karma: 100,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'karma_threshold',
            default_min_karma: 100,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 50 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('read');
      expect(result.source).toBe('karma_below_threshold');
    });

    it('should return none for karma below threshold on private repo', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'karma_threshold',
            min_karma: 100,
            is_private: true,
            ownership_model: 'open',
            default_agent_access: 'karma_threshold',
            default_min_karma: 100,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 50 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('none');
      expect(result.source).toBe('karma_below_threshold');
    });

    it('should return none for allowlist mode without explicit access', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'allowlist',
            min_karma: 0,
            is_private: false,
            ownership_model: 'guild',
            default_agent_access: 'allowlist',
            default_min_karma: 0,
            is_platform_org: false
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 1000 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('none');
      expect(result.source).toBe('not_allowlisted');
    });

    it('should return read access for platform org public repos', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'none',
            min_karma: 0,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'none',
            default_min_karma: 0,
            is_platform_org: true
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 0 }] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('read');
      expect(result.source).toBe('platform_public');
    });

    it('should return not_found for non-existent repo', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.resolvePermissions(agentId, repoId);

      expect(result.level).toBe('none');
      expect(result.source).toBe('not_found');
    });
  });

  describe('canPerform', () => {
    it('should allow read with read level', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'none',
            min_karma: 0,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'none',
            default_min_karma: 0,
            is_platform_org: true
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 0 }] });

      const result = await service.canPerform('agent-1', 'repo-1', 'read');

      expect(result.allowed).toBe(true);
    });

    it('should not allow write with read level', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'none',
            min_karma: 0,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'none',
            default_min_karma: 0,
            is_platform_org: true
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 0 }] });

      const result = await service.canPerform('agent-1', 'repo-1', 'write');

      expect(result.allowed).toBe(false);
    });

    it('should allow merge with maintain level', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] });

      const result = await service.canPerform('agent-1', 'repo-1', 'merge');

      expect(result.allowed).toBe(true);
    });

    it('should allow settings with admin level', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      const result = await service.canPerform('agent-1', 'repo-1', 'settings');

      expect(result.allowed).toBe(true);
    });

    it('should not allow settings with maintain level', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] });

      const result = await service.canPerform('agent-1', 'repo-1', 'settings');

      expect(result.allowed).toBe(false);
    });
  });

  describe('canPushToBranch', () => {
    it('should not allow push with insufficient permissions', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            agent_access: 'none',
            min_karma: 0,
            is_private: false,
            ownership_model: 'open',
            default_agent_access: 'none',
            default_min_karma: 0,
            is_platform_org: true
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 0 }] });

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'main');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('insufficient_permissions');
    });

    it('should check branch rules and deny protected branch', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ access_level: 'write', expires_at: null }] })
        .mockResolvedValueOnce({
          rows: [{
            branch_pattern: 'main',
            direct_push: 'none',
            priority: 1
          }]
        });

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'main');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('branch_protected');
    });

    it('should allow push to protected branch for maintainers', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] })
        .mockResolvedValueOnce({
          rows: [{
            branch_pattern: 'main',
            direct_push: 'maintainers',
            priority: 1
          }]
        });

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'main');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('maintainer');
    });

    it('should deny non-maintainers on maintainers-only branch', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ access_level: 'write', expires_at: null }] })
        .mockResolvedValueOnce({
          rows: [{
            branch_pattern: 'main',
            direct_push: 'maintainers',
            priority: 1
          }]
        });

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'main');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('maintainers_only');
    });

    it('should allow push when branch rule allows all', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ access_level: 'write', expires_at: null }] })
        .mockResolvedValueOnce({
          rows: [{
            branch_pattern: 'feature/*',
            direct_push: 'all',
            priority: 1
          }]
        });

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'feature/new-thing');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('allowed');
    });

    it('should allow push with no matching branch rule', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ access_level: 'write', expires_at: null }] })
        .mockResolvedValueOnce({ rows: [] }); // No branch rules

      const result = await service.canPushToBranch('agent-1', 'repo-1', 'feature/test');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no_branch_rule');
    });
  });

  describe('checkConsensus', () => {
    it('should require minimum reviews', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 2,
            ownership_model: 'open',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({ rows: [{ verdict: 'approve', karma: 100 }] });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(false);
      expect(result.reason).toBe('insufficient_reviews');
      expect(result.current).toBe(1);
      expect(result.required).toBe(2);
    });

    it('should handle solo ownership model requiring owner approval', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 1,
            ownership_model: 'solo',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            verdict: 'approve',
            karma: 100,
            is_maintainer: true,
            is_human: false
          }]
        });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(true);
      expect(result.reason).toBe('owner_approved');
    });

    it('should handle solo model without owner approval', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 1,
            ownership_model: 'solo',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            verdict: 'approve',
            karma: 100,
            is_maintainer: false,
            is_human: false
          }]
        });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(false);
      expect(result.reason).toBe('awaiting_owner');
    });

    it('should handle guild ownership model with maintainer consensus', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 2,
            ownership_model: 'guild',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({
          rows: [
            { verdict: 'approve', karma: 100, is_maintainer: true, is_human: false },
            { verdict: 'approve', karma: 200, is_maintainer: true, is_human: false },
            { verdict: 'reject', karma: 50, is_maintainer: true, is_human: false }
          ]
        });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(true);
      expect(result.ratio).toBeCloseTo(0.67, 1);
      expect(result.maintainer_approvals).toBe(2);
      expect(result.maintainer_rejections).toBe(1);
    });

    it('should handle open model with karma-weighted consensus', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 2,
            ownership_model: 'open',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({
          rows: [
            { verdict: 'approve', karma: 100, is_maintainer: false, is_human: false, tested: true },
            { verdict: 'approve', karma: 400, is_maintainer: false, is_human: false, tested: true }
          ]
        });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(true);
      expect(result.reason).toBe('consensus_reached');
    });

    it('should weight human reviews appropriately', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.5,
            min_reviews: 2,
            ownership_model: 'open',
            human_review_weight: 2.0
          }]
        })
        .mockResolvedValueOnce({
          rows: [
            { verdict: 'approve', karma: null, is_maintainer: false, is_human: true },
            { verdict: 'reject', karma: 100, is_maintainer: false, is_human: false }
          ]
        });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      // Human approval weight: 2.0
      // Agent rejection weight: sqrt(101) ≈ 10.05
      // Total: 2.0 + 10.05 = 12.05
      // Approval ratio: 2.0 / 12.05 ≈ 0.166
      expect(result.reached).toBe(false);
    });

    it('should handle no reviews case', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            consensus_threshold: 0.66,
            min_reviews: 0,
            ownership_model: 'open',
            human_review_weight: 1.5
          }]
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(false);
      expect(result.reason).toBe('no_reviews');
    });

    it('should handle repo not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.checkConsensus('patch-1', 'repo-1');

      expect(result.reached).toBe(false);
      expect(result.reason).toBe('repo_not_found');
    });
  });

  describe('matchesBranchPattern', () => {
    it('should match exact branch names', () => {
      expect(service.matchesBranchPattern('main', 'main')).toBe(true);
      expect(service.matchesBranchPattern('main', 'master')).toBe(false);
    });

    it('should match wildcard patterns', () => {
      expect(service.matchesBranchPattern('feature/new-thing', 'feature/*')).toBe(true);
      expect(service.matchesBranchPattern('feature/nested/path', 'feature/*')).toBe(true);
      expect(service.matchesBranchPattern('bugfix/issue-123', 'feature/*')).toBe(false);
    });

    it('should match star-only pattern for all branches', () => {
      expect(service.matchesBranchPattern('main', '*')).toBe(true);
      expect(service.matchesBranchPattern('feature/test', '*')).toBe(true);
    });

    it('should handle complex patterns', () => {
      expect(service.matchesBranchPattern('release/v1.0.0', 'release/*')).toBe(true);
      expect(service.matchesBranchPattern('hotfix/critical-bug', 'hotfix/*')).toBe(true);
    });
  });

  describe('isMaintainer', () => {
    it('should return true for maintainer', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] });

      const result = await service.isMaintainer('agent-1', 'repo-1');

      expect(result.isMaintainer).toBe(true);
      expect(result.role).toBe('maintainer');
    });

    it('should return true for owner', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      const result = await service.isMaintainer('agent-1', 'repo-1');

      expect(result.isMaintainer).toBe(true);
      expect(result.role).toBe('owner');
    });

    it('should return false for non-maintainer', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.isMaintainer('agent-1', 'repo-1');

      expect(result.isMaintainer).toBe(false);
      expect(result.role).toBeUndefined();
    });
  });

  describe('isOwner', () => {
    it('should return true for owner', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{}] });

      const result = await service.isOwner('agent-1', 'repo-1');

      expect(result).toBe(true);
    });

    it('should return false for non-owner', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.isOwner('agent-1', 'repo-1');

      expect(result).toBe(false);
    });
  });

  describe('checkRepoCreationLimit', () => {
    it('should deny agents with karma below 100', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ karma: 50 }] });

      const result = await service.checkRepoCreationLimit('agent-1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('karma_too_low');
      expect(result.required_karma).toBe(100);
    });

    it('should allow agents with sufficient karma and no usage', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ karma: 500 }] })
        .mockResolvedValueOnce({ rows: [{ daily: '0', weekly: '0', monthly: '0' }] });

      const result = await service.checkRepoCreationLimit('agent-1');

      expect(result.allowed).toBe(true);
      expect(result.limit.daily).toBe(2);
      expect(result.limit.weekly).toBe(5);
    });

    it('should deny when daily limit reached', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ karma: 500 }] })
        .mockResolvedValueOnce({ rows: [{ daily: '2', weekly: '2', monthly: '2' }] });

      const result = await service.checkRepoCreationLimit('agent-1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('daily_limit_reached');
    });

    it('should deny when weekly limit reached', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ karma: 500 }] })
        .mockResolvedValueOnce({ rows: [{ daily: '0', weekly: '5', monthly: '5' }] });

      const result = await service.checkRepoCreationLimit('agent-1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('weekly_limit_reached');
    });

    it('should grant higher limits to high karma agents', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ karma: 10000 }] })
        .mockResolvedValueOnce({ rows: [{ daily: '0', weekly: '0', monthly: '0' }] });

      const result = await service.checkRepoCreationLimit('agent-1');

      expect(result.allowed).toBe(true);
      expect(result.limit.daily).toBe(20);
      expect(result.limit.monthly).toBe(-1); // Unlimited
    });
  });

  describe('requiresTestsPass', () => {
    it('should return true when branch rule requires tests', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          branch_pattern: 'main',
          require_tests_pass: true,
          priority: 1
        }]
      });

      const result = await service.requiresTestsPass('repo-1', 'main');

      expect(result).toBe(true);
    });

    it('should return false when branch rule does not require tests', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          branch_pattern: 'main',
          require_tests_pass: false,
          priority: 1
        }]
      });

      const result = await service.requiresTestsPass('repo-1', 'main');

      expect(result).toBe(false);
    });

    it('should return false when no matching rule', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.requiresTestsPass('repo-1', 'feature/test');

      expect(result).toBe(false);
    });
  });

  describe('getRequiredApprovals', () => {
    it('should return branch rule required approvals', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          branch_pattern: 'main',
          required_approvals: 3,
          priority: 1
        }]
      });

      const result = await service.getRequiredApprovals('repo-1', 'main');

      expect(result).toBe(3);
    });

    it('should fall back to repo default when no matching rule', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ min_reviews: 2 }] });

      const result = await service.getRequiredApprovals('repo-1', 'feature/test');

      expect(result).toBe(2);
    });

    it('should return 1 when no rule and no repo setting', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.getRequiredApprovals('repo-1', 'feature/test');

      expect(result).toBe(1);
    });
  });
});
