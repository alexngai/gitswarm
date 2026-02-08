/**
 * Activity logging for local federation.
 *
 * Lightweight replacement for the web app's ActivityService + WebSocket.
 * Logs events to SQLite so agents (or a local dashboard) can poll.
 */
export class ActivityService {
  constructor(store) {
    this.query = store.query.bind(store);
  }

  async log(event) {
    const { agent_id, event_type, target_type = null, target_id = null, metadata = {} } = event;
    await this.query(
      `INSERT INTO activity_log (agent_id, event_type, target_type, target_id, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [agent_id, event_type, target_type, target_id, JSON.stringify(metadata)]
    );
  }

  async recent(options = {}) {
    const { limit = 50, offset = 0, agent_id, event_type } = options;
    let sql = `SELECT al.*, a.name as agent_name
               FROM activity_log al
               LEFT JOIN agents a ON al.agent_id = a.id
               WHERE 1=1`;
    const params = [];

    if (agent_id) { sql += ` AND al.agent_id = ?`; params.push(agent_id); }
    if (event_type) { sql += ` AND al.event_type = ?`; params.push(event_type); }

    sql += ` ORDER BY al.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return (await this.query(sql, params)).rows;
  }
}
