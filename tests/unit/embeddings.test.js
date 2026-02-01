import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingsService } from '../../src/services/embeddings.js';

describe('EmbeddingsService', () => {
  let embeddingsService;
  let mockDb;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };
    // Create service without API key (disabled mode)
    embeddingsService = new EmbeddingsService(mockDb);
  });

  describe('initialization', () => {
    it('should be disabled without OPENAI_API_KEY', () => {
      expect(embeddingsService.enabled).toBe(false);
    });
  });

  describe('getKnowledgeText', () => {
    it('should combine knowledge node fields into text', () => {
      const node = {
        claim: 'This is a claim',
        evidence: 'This is evidence',
        code_example: 'const x = 1;',
        topic: 'testing',
      };

      const text = embeddingsService.getKnowledgeText(node);

      expect(text).toContain('This is a claim');
      expect(text).toContain('Evidence: This is evidence');
      expect(text).toContain('Code: const x = 1;');
      expect(text).toContain('Topic: testing');
    });

    it('should handle missing optional fields', () => {
      const node = {
        claim: 'Just a claim',
      };

      const text = embeddingsService.getKnowledgeText(node);

      expect(text).toBe('Just a claim');
    });
  });

  describe('generateEmbedding (disabled)', () => {
    it('should return null when disabled', async () => {
      const result = await embeddingsService.generateEmbedding('test text');
      expect(result).toBeNull();
    });
  });

  describe('generateEmbeddings (disabled)', () => {
    it('should return array of nulls when disabled', async () => {
      const texts = ['text1', 'text2', 'text3'];
      const result = await embeddingsService.generateEmbeddings(texts);

      expect(result).toHaveLength(3);
      expect(result.every(r => r === null)).toBe(true);
    });

    it('should handle empty array', async () => {
      const result = await embeddingsService.generateEmbeddings([]);
      expect(result).toEqual([]);
    });
  });

  describe('textSearchKnowledge', () => {
    it('should return empty array if no db', async () => {
      const service = new EmbeddingsService(null);
      const result = await service.textSearchKnowledge('test query');
      expect(result).toEqual([]);
    });

    it('should search using ILIKE', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'k1', claim: 'Test claim', author_name: 'agent1' },
        ]
      });

      const result = await embeddingsService.textSearchKnowledge('test');

      expect(result).toHaveLength(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%test%'])
      );
    });

    it('should apply hive filter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await embeddingsService.textSearchKnowledge('test', { hive_id: 'hive_1' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('hive_id'),
        expect.arrayContaining(['hive_1'])
      );
    });

    it('should apply status filter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await embeddingsService.textSearchKnowledge('test', { status: 'validated' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        expect.arrayContaining(['validated'])
      );
    });

    it('should apply min_confidence filter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await embeddingsService.textSearchKnowledge('test', { min_confidence: 0.8 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('confidence'),
        expect.arrayContaining([0.8])
      );
    });
  });

  describe('searchKnowledge', () => {
    it('should fallback to text search when disabled', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await embeddingsService.searchKnowledge('test query');

      expect(result).toEqual([]);
      expect(mockDb.query).toHaveBeenCalled();
    });
  });

  describe('updateNodeEmbedding', () => {
    it('should return false when disabled', async () => {
      const result = await embeddingsService.updateNodeEmbedding('node_1');
      expect(result).toBe(false);
    });

    it('should return false if no db', async () => {
      const service = new EmbeddingsService(null);
      const result = await service.updateNodeEmbedding('node_1');
      expect(result).toBe(false);
    });
  });

  describe('backfillEmbeddings', () => {
    it('should return zeros when disabled', async () => {
      const result = await embeddingsService.backfillEmbeddings();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('should return zeros if no db', async () => {
      const service = new EmbeddingsService(null);
      const result = await service.backfillEmbeddings();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });
  });
});
