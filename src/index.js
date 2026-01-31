import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/env.js';
import { testConnection as testDbConnection } from './config/database.js';
import { testConnection as testRedisConnection } from './config/redis.js';

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
app.register(knowledgeRoutes, { prefix: apiPrefix });
app.register(forgeRoutes, { prefix: apiPrefix });
app.register(patchRoutes, { prefix: apiPrefix });
app.register(bountyRoutes, { prefix: apiPrefix });
app.register(syncRoutes, { prefix: apiPrefix });

// Webhooks (no auth required, verified by signature)
app.register(webhookRoutes, { prefix: apiPrefix });

// Skill documentation endpoint
app.get('/skill.md', async (request, reply) => {
  reply.type('text/markdown');
  // TODO: Return skill documentation
  return '# BotHub Skill\n\nDocumentation coming soon...';
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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
