/**
 * Activity Service
 * Logs and retrieves platform activity for the dashboard.
 *
 * Enhanced to broadcast stream lifecycle events with rich payloads
 * so WebSocket subscribers can react to stream-specific changes.
 */

// Stream lifecycle event types for structured broadcasting
const STREAM_EVENTS = new Set([
  'stream_created',
  'workspace_created',
  'commit',
  'submit_for_review',
  'review_submitted',
  'stream_merged',
  'stream_abandoned',
  'stabilization',
  'promote',
  'file_written',
  'repo_init_server',
]);

class ActivityService {
  constructor(db, wsService) {
    this.db = db;
    this.wsService = wsService;
  }

  /**
   * Log an activity event and broadcast via WebSocket.
   *
   * Stream lifecycle events get a richer broadcast payload that
   * includes repo_id, stream_id, and event-specific metadata.
   */
  async logActivity(event) {
    const {
      agent_id,
      event_type,
      target_type,
      target_id,
      metadata = {}
    } = event;

    // Store in database
    if (this.db) {
      await this.db.query(`
        INSERT INTO activity_log (agent_id, event_type, target_type, target_id, metadata)
        VALUES ($1, $2, $3, $4, $5)
      `, [agent_id, event_type, target_type, target_id, JSON.stringify(metadata)]);
    }

    // Broadcast via WebSocket
    if (this.wsService) {
      if (STREAM_EVENTS.has(event_type)) {
        // Stream events get structured payloads for real-time listeners
        await this.wsService.publishActivity({
          event: event_type,
          category: 'stream',
          agent: agent_id,
          agent_name: metadata.agent_name,
          target_type,
          target_id,
          repo_id: metadata.repo_id,
          stream_id: target_type === 'stream' ? target_id : metadata.stream_id,
          ...metadata,
        });
      } else {
        // Standard event payload (backward compatible)
        await this.wsService.publishActivity({
          event: event_type,
          agent: agent_id,
          agent_name: metadata.agent_name,
          target_type,
          target_id,
          title: metadata.title,
          hive: metadata.hive,
          forge: metadata.forge,
        });
      }
    }
  }

  /**
   * Get recent activity
   */
  async getRecentActivity(options = {}) {
    const { limit = 50, offset = 0, agent_id, event_type, repo_id } = options;

    let query = `
      SELECT
        al.id,
        al.event_type,
        al.target_type,
        al.target_id,
        al.metadata,
        al.created_at as timestamp,
        a.id as agent_id,
        a.name as agent_name
      FROM activity_log al
      LEFT JOIN agents a ON al.agent_id = a.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (agent_id) {
      paramCount++;
      query += ` AND al.agent_id = $${paramCount}`;
      params.push(agent_id);
    }

    if (event_type) {
      paramCount++;
      query += ` AND al.event_type = $${paramCount}`;
      params.push(event_type);
    }

    if (repo_id) {
      paramCount++;
      query += ` AND al.metadata->>'repo_id' = $${paramCount}`;
      params.push(repo_id);
    }

    paramCount++;
    query += ` ORDER BY al.created_at DESC LIMIT $${paramCount}`;
    params.push(limit);

    paramCount++;
    query += ` OFFSET $${paramCount}`;
    params.push(offset);

    if (!this.db) {
      return [];
    }

    const result = await this.db.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      event: row.event_type,
      category: STREAM_EVENTS.has(row.event_type) ? 'stream' : 'platform',
      agent: row.agent_id,
      agent_name: row.agent_name,
      target_type: row.target_type,
      target_id: row.target_id,
      repo_id: row.metadata?.repo_id,
      title: row.metadata?.title,
      hive: row.metadata?.hive,
      forge: row.metadata?.forge,
      metadata: row.metadata,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Get stream-specific activity for a repo.
   */
  async getStreamActivity(repoId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    if (!this.db) return [];

    const result = await this.db.query(`
      SELECT
        al.id,
        al.event_type,
        al.target_type,
        al.target_id,
        al.metadata,
        al.created_at as timestamp,
        a.name as agent_name
      FROM activity_log al
      LEFT JOIN agents a ON al.agent_id = a.id
      WHERE al.metadata->>'repo_id' = $1
        AND al.event_type = ANY($2)
      ORDER BY al.created_at DESC
      LIMIT $3 OFFSET $4
    `, [repoId, Array.from(STREAM_EVENTS), limit, offset]);

    return result.rows.map(row => ({
      id: row.id,
      event: row.event_type,
      agent_name: row.agent_name,
      target_type: row.target_type,
      target_id: row.target_id,
      metadata: row.metadata,
      timestamp: row.timestamp,
    }));
  }
}

export default ActivityService;
