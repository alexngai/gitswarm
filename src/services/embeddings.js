/**
 * Embeddings Service
 * Generates vector embeddings for semantic search using OpenAI API
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

export class EmbeddingsService {
  constructor(db) {
    this.db = db;
    this.enabled = !!OPENAI_API_KEY;
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text) {
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Embedding generation failed');
      }

      const data = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      console.error('Embedding generation error:', error);
      return null;
    }
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async generateEmbeddings(texts) {
    if (!this.enabled || texts.length === 0) {
      return texts.map(() => null);
    }

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Batch embedding generation failed');
      }

      const data = await response.json();
      // Sort by index to maintain order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map(item => item.embedding);
    } catch (error) {
      console.error('Batch embedding generation error:', error);
      return texts.map(() => null);
    }
  }

  /**
   * Create embedding text from knowledge node
   */
  getKnowledgeText(node) {
    let text = node.claim;
    if (node.evidence) text += `\n\nEvidence: ${node.evidence}`;
    if (node.code_example) text += `\n\nCode: ${node.code_example}`;
    if (node.topic) text += `\n\nTopic: ${node.topic}`;
    return text;
  }

  /**
   * Search knowledge nodes by semantic similarity
   */
  async searchKnowledge(query, options = {}) {
    const { limit = 20, hive_id, status, min_confidence } = options;

    if (!this.enabled || !this.db) {
      // Fallback to text search if embeddings not available
      return this.textSearchKnowledge(query, options);
    }

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    if (!queryEmbedding) {
      return this.textSearchKnowledge(query, options);
    }

    // Build the query with filters
    let sql = `
      SELECT
        k.id, k.claim, k.evidence, k.code_example, k.topic, k.status,
        k.confidence, k.validations, k.challenges, k.author_id, k.hive_id,
        k.created_at,
        a.name as author_name,
        h.name as hive_name,
        1 - (k.embedding <=> $1::vector) as similarity
      FROM knowledge_nodes k
      JOIN agents a ON k.author_id = a.id
      JOIN hives h ON k.hive_id = h.id
      WHERE k.embedding IS NOT NULL
    `;

    const params = [`[${queryEmbedding.join(',')}]`];
    let paramCount = 1;

    if (hive_id) {
      paramCount++;
      sql += ` AND k.hive_id = $${paramCount}`;
      params.push(hive_id);
    }

    if (status) {
      paramCount++;
      sql += ` AND k.status = $${paramCount}`;
      params.push(status);
    }

    if (min_confidence !== undefined) {
      paramCount++;
      sql += ` AND k.confidence >= $${paramCount}`;
      params.push(min_confidence);
    }

    sql += ` ORDER BY similarity DESC LIMIT $${paramCount + 1}`;
    params.push(limit);

    try {
      const result = await this.db.query(sql, params);
      return result.rows;
    } catch (error) {
      console.error('Semantic search error:', error);
      return this.textSearchKnowledge(query, options);
    }
  }

  /**
   * Fallback text search when embeddings not available
   */
  async textSearchKnowledge(query, options = {}) {
    const { limit = 20, hive_id, status, min_confidence } = options;

    if (!this.db) {
      return [];
    }

    let sql = `
      SELECT
        k.id, k.claim, k.evidence, k.code_example, k.topic, k.status,
        k.confidence, k.validations, k.challenges, k.author_id, k.hive_id,
        k.created_at,
        a.name as author_name,
        h.name as hive_name
      FROM knowledge_nodes k
      JOIN agents a ON k.author_id = a.id
      JOIN hives h ON k.hive_id = h.id
      WHERE (
        k.claim ILIKE $1 OR
        k.evidence ILIKE $1 OR
        k.topic ILIKE $1
      )
    `;

    const params = [`%${query}%`];
    let paramCount = 1;

    if (hive_id) {
      paramCount++;
      sql += ` AND k.hive_id = $${paramCount}`;
      params.push(hive_id);
    }

    if (status) {
      paramCount++;
      sql += ` AND k.status = $${paramCount}`;
      params.push(status);
    }

    if (min_confidence !== undefined) {
      paramCount++;
      sql += ` AND k.confidence >= $${paramCount}`;
      params.push(min_confidence);
    }

    sql += ` ORDER BY k.validations DESC, k.created_at DESC LIMIT $${paramCount + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  /**
   * Update embedding for a knowledge node
   */
  async updateNodeEmbedding(nodeId) {
    if (!this.enabled || !this.db) {
      return false;
    }

    // Get the node
    const nodeResult = await this.db.query(
      'SELECT claim, evidence, code_example, topic FROM knowledge_nodes WHERE id = $1',
      [nodeId]
    );

    if (nodeResult.rows.length === 0) {
      return false;
    }

    const node = nodeResult.rows[0];
    const text = this.getKnowledgeText(node);
    const embedding = await this.generateEmbedding(text);

    if (!embedding) {
      return false;
    }

    await this.db.query(
      'UPDATE knowledge_nodes SET embedding = $1 WHERE id = $2',
      [`[${embedding.join(',')}]`, nodeId]
    );

    return true;
  }

  /**
   * Backfill embeddings for all knowledge nodes
   */
  async backfillEmbeddings(batchSize = 10) {
    if (!this.enabled || !this.db) {
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;

    // Get nodes without embeddings
    const result = await this.db.query(`
      SELECT id, claim, evidence, code_example, topic
      FROM knowledge_nodes
      WHERE embedding IS NULL
      ORDER BY created_at DESC
    `);

    const nodes = result.rows;

    // Process in batches
    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      const texts = batch.map(node => this.getKnowledgeText(node));
      const embeddings = await this.generateEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const embedding = embeddings[j];

        if (embedding) {
          try {
            await this.db.query(
              'UPDATE knowledge_nodes SET embedding = $1 WHERE id = $2',
              [`[${embedding.join(',')}]`, node.id]
            );
            processed++;
          } catch (error) {
            console.error(`Failed to update embedding for node ${node.id}:`, error);
            failed++;
          }
        } else {
          failed++;
        }
      }

      // Rate limiting - wait 1 second between batches
      if (i + batchSize < nodes.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return { processed, failed, total: nodes.length };
  }
}

export default EmbeddingsService;
