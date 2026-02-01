/**
 * Activity Service
 * Logs and retrieves platform activity for the dashboard
 */

class ActivityService {
  constructor(db, wsService) {
    this.db = db;
    this.wsService = wsService;
  }

  /**
   * Log an activity event
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

  /**
   * Get recent activity
   */
  async getRecentActivity(options = {}) {
    const { limit = 50, offset = 0, agent_id, event_type } = options;

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
      agent: row.agent_id,
      agent_name: row.agent_name,
      target_type: row.target_type,
      target_id: row.target_id,
      title: row.metadata?.title,
      hive: row.metadata?.hive,
      forge: row.metadata?.forge,
      timestamp: row.timestamp,
    }));
  }
}

export default ActivityService;
