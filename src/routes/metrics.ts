/**
 * Prometheus Metrics Endpoint
 * Exposes application metrics in Prometheus format
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface DurationEntry {
  method: string;
  path: string;
  duration: number;
}

interface MetricsStore {
  http_requests_total: Map<string, number>;
  http_request_duration_seconds: DurationEntry[];
  active_websocket_connections: number;
  agents_total: number;
  hives_total: number;
  posts_total: number;
  patches_total: number;
  knowledge_nodes_total: number;
  bounties_open: number;
  notifications_queued: number;
  notifications_delivered: number;
  [key: string]: unknown;
}

// In-memory metrics storage (for simplicity; can use prom-client for production)
const metrics: MetricsStore = {
  http_requests_total: new Map(), // method:path:status -> count
  http_request_duration_seconds: [], // array of {method, path, duration}
  active_websocket_connections: 0,
  agents_total: 0,
  hives_total: 0,
  posts_total: 0,
  patches_total: 0,
  knowledge_nodes_total: 0,
  bounties_open: 0,
  notifications_queued: 0,
  notifications_delivered: 0,
};

// Track request metrics
export function recordRequest(method: string, path: string, statusCode: number, duration: number): void {
  const key = `${method}:${path}:${statusCode}`;
  metrics.http_requests_total.set(key, (metrics.http_requests_total.get(key) || 0) + 1);

  // Keep last 1000 durations for histogram calculation
  metrics.http_request_duration_seconds.push({ method, path, duration });
  if (metrics.http_request_duration_seconds.length > 1000) {
    metrics.http_request_duration_seconds.shift();
  }
}

// Update gauge metrics
export function updateGauge(name: string, value: number): void {
  if (name in metrics) {
    metrics[name] = value;
  }
}

// Calculate histogram buckets
function calculateHistogram(durations: DurationEntry[], buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]): Record<string, number> {
  const result = {};
  buckets.forEach(bucket => {
    result[bucket] = durations.filter(d => d.duration <= bucket).length;
  });
  result['+Inf'] = durations.length;
  return result;
}

// Format metrics as Prometheus text
function formatMetrics(db: Record<string, any> | null): string {
  const lines = [];
  const timestamp = Date.now();

  // HTTP request counter
  lines.push('# HELP http_requests_total Total number of HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, count] of metrics.http_requests_total) {
    const [method, path, status] = key.split(':');
    lines.push(`http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
  }

  // HTTP request duration histogram
  if (metrics.http_request_duration_seconds.length > 0) {
    lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds');
    lines.push('# TYPE http_request_duration_seconds histogram');

    const histogram = calculateHistogram(metrics.http_request_duration_seconds);
    const sum = metrics.http_request_duration_seconds.reduce((acc, d) => acc + d.duration, 0);

    for (const [le, count] of Object.entries(histogram)) {
      lines.push(`http_request_duration_seconds_bucket{le="${le}"} ${count}`);
    }
    lines.push(`http_request_duration_seconds_sum ${sum.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count ${metrics.http_request_duration_seconds.length}`);
  }

  // WebSocket connections gauge
  lines.push('# HELP websocket_connections_active Current number of active WebSocket connections');
  lines.push('# TYPE websocket_connections_active gauge');
  lines.push(`websocket_connections_active ${metrics.active_websocket_connections}`);

  // Application metrics (gauges)
  lines.push('# HELP bothub_agents_total Total number of registered agents');
  lines.push('# TYPE bothub_agents_total gauge');
  lines.push(`bothub_agents_total ${metrics.agents_total}`);

  lines.push('# HELP bothub_hives_total Total number of hives');
  lines.push('# TYPE bothub_hives_total gauge');
  lines.push(`bothub_hives_total ${metrics.hives_total}`);

  lines.push('# HELP bothub_posts_total Total number of posts');
  lines.push('# TYPE bothub_posts_total gauge');
  lines.push(`bothub_posts_total ${metrics.posts_total}`);

  lines.push('# HELP bothub_patches_total Total number of patches');
  lines.push('# TYPE bothub_patches_total gauge');
  lines.push(`bothub_patches_total ${metrics.patches_total}`);

  lines.push('# HELP bothub_knowledge_nodes_total Total number of knowledge nodes');
  lines.push('# TYPE bothub_knowledge_nodes_total gauge');
  lines.push(`bothub_knowledge_nodes_total ${metrics.knowledge_nodes_total}`);

  lines.push('# HELP bothub_bounties_open Number of open bounties');
  lines.push('# TYPE bothub_bounties_open gauge');
  lines.push(`bothub_bounties_open ${metrics.bounties_open}`);

  lines.push('# HELP bothub_notifications_queued Number of notifications in queue');
  lines.push('# TYPE bothub_notifications_queued gauge');
  lines.push(`bothub_notifications_queued ${metrics.notifications_queued}`);

  lines.push('# HELP bothub_notifications_delivered Total notifications delivered');
  lines.push('# TYPE bothub_notifications_delivered counter');
  lines.push(`bothub_notifications_delivered ${metrics.notifications_delivered}`);

  // Node.js runtime metrics
  const memUsage = process.memoryUsage();
  lines.push('# HELP nodejs_heap_size_bytes Node.js heap size in bytes');
  lines.push('# TYPE nodejs_heap_size_bytes gauge');
  lines.push(`nodejs_heap_size_total_bytes ${memUsage.heapTotal}`);
  lines.push(`nodejs_heap_size_used_bytes ${memUsage.heapUsed}`);
  lines.push(`nodejs_external_memory_bytes ${memUsage.external}`);

  lines.push('# HELP nodejs_process_uptime_seconds Node.js process uptime');
  lines.push('# TYPE nodejs_process_uptime_seconds gauge');
  lines.push(`nodejs_process_uptime_seconds ${process.uptime().toFixed(2)}`);

  return lines.join('\n');
}

export default async function metricsRoutes(fastify: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { db, wsService } = options;

  // Refresh database metrics periodically
  async function refreshDbMetrics(): Promise<void> {
    if (!db) return;

    try {
      const [agents, hives, posts, patches, knowledge, bounties, notifications] = await Promise.all([
        db.query('SELECT COUNT(*) FROM agents'),
        db.query('SELECT COUNT(*) FROM hives'),
        db.query('SELECT COUNT(*) FROM posts'),
        db.query('SELECT COUNT(*) FROM patches'),
        db.query('SELECT COUNT(*) FROM knowledge_nodes'),
        db.query("SELECT COUNT(*) FROM bounties WHERE status = 'open'"),
        db.query('SELECT COUNT(*) FROM agent_notifications WHERE delivered = false'),
      ]);

      metrics.agents_total = parseInt(agents.rows[0]?.count || 0);
      metrics.hives_total = parseInt(hives.rows[0]?.count || 0);
      metrics.posts_total = parseInt(posts.rows[0]?.count || 0);
      metrics.patches_total = parseInt(patches.rows[0]?.count || 0);
      metrics.knowledge_nodes_total = parseInt(knowledge.rows[0]?.count || 0);
      metrics.bounties_open = parseInt(bounties.rows[0]?.count || 0);
      metrics.notifications_queued = parseInt(notifications.rows[0]?.count || 0);
    } catch (error) {
      console.error('Failed to refresh metrics:', error);
    }
  }

  // Update WebSocket connection count
  if (wsService) {
    setInterval(() => {
      metrics.active_websocket_connections = wsService.getConnectionCount();
    }, 5000);
  }

  // Refresh DB metrics every 30 seconds
  setInterval(refreshDbMetrics, 30000);
  refreshDbMetrics(); // Initial load

  /**
   * GET /metrics
   * Prometheus metrics endpoint
   */
  fastify.get('/metrics', async (request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return formatMetrics(db);
  });
}

export { metrics };
