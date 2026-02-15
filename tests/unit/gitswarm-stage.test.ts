import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StageProgressionService } from '../../src/services/stage-progression.js';

describe('StageProgressionService', () => {
  let stageService: InstanceType<typeof StageProgressionService>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    stageService = new StageProgressionService({ query: mockQuery } as any);
  });

  describe('getStageMetrics', () => {
    it('should return metrics for a repository', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'growth',
          contributor_count: 5,
          patch_count: 12,
          maintainer_count: '2',
          council_count: '0'
        }]
      });

      const metrics = await stageService.getStageMetrics('repo-uuid');

      expect(metrics.current_stage).toBe('growth');
      expect(metrics.metrics.contributor_count).toBe(5);
      expect(metrics.metrics.patch_count).toBe(12);
      expect(metrics.metrics.maintainer_count).toBe(2);
      expect(metrics.metrics.has_council).toBe(false);
    });

    it('should throw error if repo not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(stageService.getStageMetrics('not-found')).rejects.toThrow('Repository not found');
    });
  });

  describe('checkAdvancementEligibility', () => {
    it('should return eligible when requirements are met', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 3,
          patch_count: 5,
          maintainer_count: '2',
          council_count: '0'
        }]
      });

      const result = await stageService.checkAdvancementEligibility('repo-uuid');

      expect(result.eligible).toBe(true);
      expect(result.current_stage).toBe('seed');
      expect(result.next_stage).toBe('growth');
      expect(result.unmet_requirements).toHaveLength(0);
    });

    it('should return not eligible with unmet requirements', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 1,
          patch_count: 1,
          maintainer_count: '0',
          council_count: '0'
        }]
      });

      const result = await stageService.checkAdvancementEligibility('repo-uuid');

      expect(result.eligible).toBe(false);
      expect(result.unmet_requirements.length).toBeGreaterThan(0);
      expect(result.unmet_requirements.map(r => r.requirement)).toContain('min_contributors');
    });

    it('should return not eligible when at mature stage', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'mature',
          contributor_count: 20,
          patch_count: 50,
          maintainer_count: '5',
          council_count: '1'
        }]
      });

      const result = await stageService.checkAdvancementEligibility('repo-uuid');

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_at_max_stage');
      expect(result.next_stage).toBe(null);
    });

    it('should require council for mature stage', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'established',
          contributor_count: 15,
          patch_count: 30,
          maintainer_count: '4',
          council_count: '0'
        }]
      });

      const result = await stageService.checkAdvancementEligibility('repo-uuid');

      expect(result.eligible).toBe(false);
      expect(result.unmet_requirements.map(r => r.requirement)).toContain('has_council');
    });
  });

  describe('advanceStage', () => {
    it('should advance stage when eligible', async () => {
      // First call - getStageMetrics
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 3,
          patch_count: 5,
          maintainer_count: '2',
          council_count: '0'
        }]
      });

      // Second call - record history
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Third call - update repo stage
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await stageService.advanceStage('repo-uuid');

      expect(result.success).toBe(true);
      expect(result.previous_stage).toBe('seed');
      expect(result.new_stage).toBe('growth');
    });

    it('should not advance when not eligible', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 1,
          patch_count: 1,
          maintainer_count: '0',
          council_count: '0'
        }]
      });

      const result = await stageService.advanceStage('repo-uuid');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('requirements_not_met');
    });

    it('should force advance when force=true', async () => {
      // First call - getStageMetrics
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 1,
          patch_count: 1,
          maintainer_count: '0',
          council_count: '0'
        }]
      });

      // Second call - record history
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Third call - update repo stage
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await stageService.advanceStage('repo-uuid', true);

      expect(result.success).toBe(true);
      expect(result.forced).toBe(true);
    });
  });

  describe('setStage', () => {
    it('should set stage directly', async () => {
      // First call - getStageMetrics
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'seed',
          contributor_count: 1,
          patch_count: 1,
          maintainer_count: '0',
          council_count: '0'
        }]
      });

      // Second call - record history
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Third call - update repo stage
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await stageService.setStage('repo-uuid', 'mature', 'Admin override');

      expect(result.success).toBe(true);
      expect(result.previous_stage).toBe('seed');
      expect(result.new_stage).toBe('mature');
    });

    it('should reject invalid stage', async () => {
      await expect(stageService.setStage('repo-uuid', 'invalid')).rejects.toThrow('Invalid stage');
    });

    it('should return error when already at target stage', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          stage: 'growth',
          contributor_count: 3,
          patch_count: 5,
          maintainer_count: '2',
          council_count: '0'
        }]
      });

      const result = await stageService.setStage('repo-uuid', 'growth');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_at_stage');
    });
  });

  describe('getStageHistory', () => {
    it('should return stage history', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { from_stage: 'seed', to_stage: 'growth', transitioned_at: new Date() },
          { from_stage: 'growth', to_stage: 'established', transitioned_at: new Date() }
        ]
      });

      const history = await stageService.getStageHistory('repo-uuid');

      expect(history).toHaveLength(2);
    });
  });

  describe('getStageRequirements', () => {
    it('should return requirements for a stage', () => {
      const result = stageService.getStageRequirements('growth');

      expect(result.requirements.min_contributors).toBe(2);
      expect(result.requirements.min_patches).toBe(3);
    });

    it('should return null requirements for seed stage', () => {
      const result = stageService.getStageRequirements('seed');

      expect(result.requirements).toBe(null);
    });
  });

  describe('updateRepoMetrics', () => {
    it('should update contributor and patch counts', async () => {
      // Query 1: COUNT from streams (contributor + stream count in one query)
      mockQuery.mockResolvedValueOnce({ rows: [{ contributor_count: '5', stream_count: '12' }] });
      // Query 2: COUNT from merges (contributor + merge count)
      mockQuery.mockResolvedValueOnce({ rows: [{ contributor_count: '3', merge_count: '10' }] });
      // Query 3: UPDATE repos
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await stageService.updateRepoMetrics('repo-uuid');

      // Takes the max of streams vs merges
      expect(result.contributor_count).toBe(5);
      expect(result.patch_count).toBe(12);
    });
  });
});
