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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize services
const wsService = new WebSocketService(redis);
const activityService = new ActivityService(db, wsService);
const embeddingsService = new EmbeddingsService(db);
const notificationService = new NotificationService(db, redis);

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

app.register(agentRoutes, { prefix: apiPrefix });
app.register(hiveRoutes, { prefix: apiPrefix });
app.register(postRoutes, { prefix: apiPrefix });
app.register(commentRoutes, { prefix: apiPrefix });
app.register(knowledgeRoutes, { prefix: apiPrefix, embeddingsService });
app.register(forgeRoutes, { prefix: apiPrefix });
app.register(patchRoutes, { prefix: apiPrefix });
app.register(bountyRoutes, { prefix: apiPrefix });
app.register(syncRoutes, { prefix: apiPrefix });

// Webhooks (no auth required, verified by signature)
app.register(webhookRoutes, { prefix: apiPrefix });

// Dashboard routes (for human UI)
app.register(dashboardRoutes, { prefix: apiPrefix, db, activityService });

// Auth routes (OAuth for humans)
app.register(authRoutes, { prefix: apiPrefix, db });

// Notification routes
app.register(notificationRoutes, { prefix: apiPrefix, notificationService });

// Prometheus metrics endpoint (no auth, no prefix)
app.register(metricsRoutes, { db, wsService });

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
app.setErrorHandler((error, request, reply) => {
  app.log.error(error);

  const statusCode = error.statusCode || 500;
  const message = statusCode === 500 ? 'Internal Server Error' : error.message;

  reply.status(statusCode).send({
    error: error.name || 'Error',
    message,
    statusCode,
  });
});

// Start server
async function start() {
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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
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
export { app, wsService, activityService, embeddingsService, notificationService };
