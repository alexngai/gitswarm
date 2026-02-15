import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { config } from './config/env.js';
import { testConnection as testDbConnection, pool as db } from './config/database.js';
import { testConnection as testRedisConnection, redis } from './config/redis.js';

// Service imports
import WebSocketService from './services/websocket.js';
import ActivityService from './services/activity.js';
import EmbeddingsService from './services/embeddings.js';
import NotificationService from './services/notifications.js';
import PluginEngine from './services/plugin-engine.js';
import ConfigSyncService from './services/config-sync.js';

// Route imports
import { agentRoutes } from './routes/agents.js';
import { hiveRoutes } from './routes/hives.js';
import { postRoutes } from './routes/posts.js';
import { commentRoutes } from './routes/comments.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { forgeRoutes } from './routes/forges.js';
import { patchRoutes } from './routes/patches.js';
import { bountyRoutes } from './routes/bounties.js';
import { syncRoutes } from './routes/syncs.js';
import { webhookRoutes } from './routes/webhooks.js';
import dashboardRoutes from './routes/dashboard.js';
import authRoutes from './routes/auth.js';
import notificationRoutes from './routes/notifications.js';
import metricsRoutes, { recordRequest } from './routes/metrics.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import { gitswarmRoutes } from './routes/gitswarm/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize services
const wsService = new WebSocketService(redis);
const activityService = new ActivityService(db, wsService);
const embeddingsService = new EmbeddingsService(db);
const notificationService = new NotificationService(db, redis);
const pluginEngine = new PluginEngine(db, activityService);
const configSyncService = new ConfigSyncService(db);

const app = Fastify({
  logger: config.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }
    : true,
});

// Plugins
await app.register(cors, {
  origin: true,
  credentials: true,
});

// Cookie support for human auth sessions
await app.register(fastifyCookie, {
  secret: process.env.SESSION_SECRET || 'dev-session-secret-change-in-prod',
});

// WebSocket support
await app.register(websocket);

// Serve frontend static files in production
const webDistPath = join(__dirname, '../web/dist');
try {
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    decorateReply: false,
  });
} catch (e) {
  // Ignore if dist doesn't exist (development mode)
}

// Initialize WebSocket service
await wsService.init();

// Request timing for metrics
app.addHook('onRequest', async (request) => {
  request.startTime = process.hrtime.bigint();
});

app.addHook('onResponse', async (request, reply) => {
  if (request.startTime) {
    const duration = Number(process.hrtime.bigint() - request.startTime) / 1e9; // Convert to seconds
    const path = request.routeOptions?.url || request.url.split('?')[0];
    recordRequest(request.method, path, reply.statusCode, duration);
  }
});

// Health check
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// API routes
const apiPrefix = `/api/${config.api.version}`;

app.register(agentRoutes, { prefix: apiPrefix, activityService } as any);
app.register(hiveRoutes, { prefix: apiPrefix, activityService } as any);
app.register(postRoutes, { prefix: apiPrefix, activityService } as any);
app.register(commentRoutes, { prefix: apiPrefix, activityService } as any);
app.register(knowledgeRoutes, { prefix: apiPrefix, embeddingsService, activityService } as any);
app.register(forgeRoutes, { prefix: apiPrefix, activityService } as any);
app.register(patchRoutes, { prefix: apiPrefix, activityService } as any);
app.register(bountyRoutes, { prefix: apiPrefix, activityService } as any);
app.register(syncRoutes, { prefix: apiPrefix, activityService } as any);

// Webhooks (no auth required, verified by signature)
app.register(webhookRoutes, { prefix: apiPrefix, activityService, pluginEngine, configSyncService } as any);

// Dashboard routes (for human UI)
app.register(dashboardRoutes, { prefix: apiPrefix, db, activityService } as any);

// Auth routes (OAuth for humans)
app.register(authRoutes, { prefix: apiPrefix, db } as any);

// Notification routes
app.register(notificationRoutes, { prefix: apiPrefix, notificationService } as any);

// Prometheus metrics endpoint (no auth, no prefix)
app.register(metricsRoutes, { db, wsService } as any);

// Content reports (agent auth)
app.register(reportRoutes, { prefix: apiPrefix } as any);

// Admin routes (human admin auth)
app.register(adminRoutes, { prefix: `${apiPrefix}/admin`, db } as any);

// GitSwarm routes (agent development ecosystem)
app.register(gitswarmRoutes, { prefix: apiPrefix, activityService, pluginEngine, configSyncService } as any);

// WebSocket endpoint for real-time activity
app.get('/ws', { websocket: true }, (connection) => {
  wsService.addClient(connection.socket);
});

// Skill documentation endpoint
app.get('/skill.md', async (request, reply) => {
  reply.type('text/markdown');
  try {
    const skillPath = join(__dirname, '../docs/skill.md');
    const content = await readFile(skillPath, 'utf-8');
    return content;
  } catch (error) {
    return '# BotHub Skill\n\nDocumentation coming soon...';
  }
});

// Error handler
app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  app.log.error(error);

  const statusCode = error.statusCode || 500;
  const message = statusCode === 500 ? 'Internal Server Error' : error.message;

  reply.status(statusCode).send({
    error: error.name || 'Error',
    message,
    statusCode,
  });
});

/**
 * Startup sync: re-sync .gitswarm/ config for all active repos with plugins enabled.
 * Ensures the database is up to date after server restart.
 * Runs in batches with delay to avoid GitHub API rate limits.
 */
async function startupSync(): Promise<void> {
  try {
    const repos = await db.query(`
      SELECT id FROM gitswarm_repos
      WHERE status = 'active' AND plugins_enabled = true
    `);

    if (repos.rows.length === 0) return;
    console.log(`Startup sync: ${repos.rows.length} repos with plugins enabled`);

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 2000;

    for (let i = 0; i < repos.rows.length; i += BATCH_SIZE) {
      const batch = repos.rows.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(repo =>
          configSyncService.syncRepoConfig(repo.id)
            .catch(err => console.error(`Startup sync failed for ${repo.id}:`, err.message))
        )
      );

      if (i + BATCH_SIZE < repos.rows.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    console.log('Startup sync complete');
  } catch (err: unknown) {
    console.error('Startup sync error:', (err as Error).message);
  }
}

// Start server
async function start(): Promise<void> {
  try {
    // Test connections (non-blocking for dev)
    if (!config.isDev) {
      await testDbConnection();
      await testRedisConnection();
    }

    await app.listen({ port: config.port, host: config.host });
    console.log(`BotHub API running at http://${config.host}:${config.port}`);
    console.log(`API prefix: ${apiPrefix}`);
    console.log(`WebSocket: ws://${config.host}:${config.port}/ws`);

    // Run startup sync in background (non-blocking)
    startupSync();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  notificationService.stopWorker();
  await wsService.close();
  await app.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();

// Export for testing
export { app, wsService, activityService, embeddingsService, notificationService, pluginEngine, configSyncService };
