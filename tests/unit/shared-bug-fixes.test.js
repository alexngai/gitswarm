/**
 * Bug fix verification tests — Shared Libraries
 *
 * Tests BUG-13 (string karma), BUG-14 (shallow normalize), BUG-16 (stage metrics)
 *
 * These test the shared modules directly (no HTTP layer needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── BUG-14: field-normalize.js ──────────────────────────────────

describe('BUG-14: Recursive normalizeKeys', () => {
  let camelToSnake, normalizeKeys;

  beforeEach(async () => {
    const mod = await import('../../shared/field-normalize.js');
    camelToSnake = mod.camelToSnake;
    normalizeKeys = mod.normalizeKeys;
  });

  it('should convert camelCase to snake_case', () => {
    expect(camelToSnake('baseBranch')).toBe('base_branch');
    expect(camelToSnake('mergeMode')).toBe('merge_mode');
    expect(camelToSnake('parentStreamId')).toBe('parent_stream_id');
  });

  it('should normalize flat object keys', () => {
    const input = { baseBranch: 'main', mergeMode: 'review' };
    const result = normalizeKeys(input);
    expect(result).toEqual({ base_branch: 'main', merge_mode: 'review' });
  });

  it('should recursively normalize nested objects', () => {
    const input = {
      repoConfig: {
        mergeMode: 'review',
        consensusThreshold: 0.66,
        branchRules: {
          directPush: 'none',
          requireTestsPass: true,
        },
      },
    };

    const result = normalizeKeys(input);
    expect(result.repo_config).toBeDefined();
    expect(result.repo_config.merge_mode).toBe('review');
    expect(result.repo_config.consensus_threshold).toBe(0.66);
    expect(result.repo_config.branch_rules).toBeDefined();
    expect(result.repo_config.branch_rules.direct_push).toBe('none');
    expect(result.repo_config.branch_rules.require_tests_pass).toBe(true);
  });

  it('should pass through non-objects', () => {
    expect(normalizeKeys(null)).toBe(null);
    expect(normalizeKeys(undefined)).toBe(undefined);
    expect(normalizeKeys('string')).toBe('string');
    expect(normalizeKeys(42)).toBe(42);
  });

  it('should pass through arrays without normalizing', () => {
    const arr = [{ baseBranch: 'main' }];
    expect(normalizeKeys(arr)).toBe(arr); // arrays returned as-is
  });

  it('should prefer explicit snake_case key over camelCase conversion', () => {
    const input = { baseBranch: 'camel', base_branch: 'snake' };
    const result = normalizeKeys(input);
    expect(result.base_branch).toBe('snake');
  });
});

// ── BUG-13: permissions.js karma coercion ───────────────────────

describe('BUG-13: Numeric karma coercion in PermissionService', () => {
  let PermissionService;

  beforeEach(async () => {
    const mod = await import('../../shared/permissions.js');
    PermissionService = mod.PermissionService;
  });

  it('should correctly compare string karma values (DB returns strings)', async () => {
    const mockQuery = vi.fn();

    // No explicit grant
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Not a maintainer
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Repo settings — karma_threshold mode with min_karma as string
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_access: 'karma_threshold', min_karma: '50', is_private: false, ownership_model: 'guild' }],
    });
    // Agent karma as string "100" (which would fail lexicographic comparison "100" < "50")
    mockQuery.mockResolvedValueOnce({
      rows: [{ karma: '100' }],
    });

    const service = new PermissionService({ query: mockQuery });
    const result = await service.resolvePermissions('agent-1', 'repo-1');

    // Without BUG-13 fix, "100" < "50" would be true in string comparison
    // With fix, Number(100) >= Number(50) correctly grants write access
    expect(result.level).toBe('write');
    expect(result.source).toBe('karma');
  });

  it('should handle null/undefined karma gracefully', async () => {
    const mockQuery = vi.fn();

    mockQuery.mockResolvedValueOnce({ rows: [] }); // explicit
    mockQuery.mockResolvedValueOnce({ rows: [] }); // maintainer
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_access: 'karma_threshold', min_karma: null, is_private: false, ownership_model: 'guild' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ karma: undefined }],
    });

    const service = new PermissionService({ query: mockQuery });
    const result = await service.resolvePermissions('agent-1', 'repo-1');

    // karma=0, threshold=0 → 0 >= 0 → write
    expect(result.level).toBe('write');
  });

  it('should handle missing agent row gracefully', async () => {
    const mockQuery = vi.fn();

    mockQuery.mockResolvedValueOnce({ rows: [] }); // explicit
    mockQuery.mockResolvedValueOnce({ rows: [] }); // maintainer
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_access: 'karma_threshold', min_karma: '10', is_private: true, ownership_model: 'guild' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no agent found

    const service = new PermissionService({ query: mockQuery });
    const result = await service.resolvePermissions('agent-1', 'repo-1');

    // karma=0, threshold=10, private → none
    expect(result.level).toBe('none');
  });
});

// ── BUG-16: stages.js safe coercion ─────────────────────────────

describe('BUG-16: Safe coercion in StageService', () => {
  let StageService;

  beforeEach(async () => {
    const mod = await import('../../shared/stages.js');
    StageService = mod.StageService;
  });

  it('should handle null/undefined DB values in getStageMetrics', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: 'repo-1',
        stage: 'seed',
        contributor_count: null,
        patch_count: undefined,
        maintainer_count: null,
        council_count: undefined,
      }],
    });

    const service = new StageService({ query: mockQuery });
    const result = await service.getStageMetrics('repo-1');

    // Without fix, Number(null) = 0 works but parseInt(undefined) = NaN crashes comparisons
    expect(result.metrics.contributor_count).toBe(0);
    expect(result.metrics.patch_count).toBe(0);
    expect(result.metrics.maintainer_count).toBe(0);
    expect(result.metrics.has_council).toBe(false);
    expect(Number.isNaN(result.metrics.contributor_count)).toBe(false);
    expect(Number.isNaN(result.metrics.patch_count)).toBe(false);
  });

  it('should handle string DB values in getStageMetrics', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: 'repo-1',
        stage: 'growth',
        contributor_count: '5',
        patch_count: '12',
        maintainer_count: '2',
        council_count: '1',
      }],
    });

    const service = new StageService({ query: mockQuery });
    const result = await service.getStageMetrics('repo-1');

    expect(result.metrics.contributor_count).toBe(5);
    expect(result.metrics.patch_count).toBe(12);
    expect(result.metrics.maintainer_count).toBe(2);
    expect(result.metrics.has_council).toBe(true);
  });

  it('should handle null rows in updateRepoMetrics', async () => {
    const mockQuery = vi.fn();
    // Contributors query — empty result
    mockQuery.mockResolvedValueOnce({ rows: [{ count: null }] });
    // Streams query — empty result
    mockQuery.mockResolvedValueOnce({ rows: [{ count: null }] });
    // UPDATE query
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const service = new StageService({ query: mockQuery });
    const result = await service.updateRepoMetrics('repo-1');

    expect(result.contributor_count).toBe(0);
    expect(result.patch_count).toBe(0);
  });

  it('should correctly assess advancement eligibility with coerced values', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: 'repo-1',
        stage: 'seed',
        contributor_count: '2',
        patch_count: '3',
        maintainer_count: '1',
        council_count: '0',
      }],
    });

    const service = new StageService({ query: mockQuery });
    const result = await service.checkAdvancementEligibility('repo-1');

    // seed → growth requires min_contributors:2, min_patches:3, min_maintainers:1
    expect(result.eligible).toBe(true);
    expect(result.next_stage).toBe('growth');
  });
});
