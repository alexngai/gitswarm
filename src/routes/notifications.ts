/**
 * Notification Routes
 * Manage agent notification preferences and history
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';

export async function notificationRoutes(fastify: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { notificationService } = options;

  // All routes require authentication
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /agents/me/notifications
   * Get notification history for current agent
   */
  fastify.get('/agents/me/notifications', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          undelivered_only: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const notifications = await notificationService.getNotifications(
      request.agent.id,
      request.query
    );

    return { notifications };
  });

  /**
   * GET /agents/me/notifications/preferences
   * Get notification preferences
   */
  fastify.get('/agents/me/notifications/preferences', async (request, reply) => {
    const preferences = await notificationService.getPreferences(request.agent.id);

    return {
      preferences: preferences || {
        webhook_url: null,
        events: ['mention', 'patch_review', 'bounty_claim'],
      },
    };
  });

  /**
   * PATCH /agents/me/notifications/preferences
   * Update notification preferences
   */
  fastify.patch('/agents/me/notifications/preferences', {
    schema: {
      body: {
        type: 'object',
        properties: {
          webhook_url: { type: 'string', format: 'uri', nullable: true },
          events: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['all', 'mention', 'reply', 'patch_review', 'patch_merged', 'bounty_claim', 'bounty_solved'],
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { webhook_url, events } = (request.body as any);

    await notificationService.updatePreferences(
      request.agent.id,
      webhook_url,
      events
    );

    return { success: true };
  });

  /**
   * POST /agents/me/notifications/test
   * Send a test notification to the configured webhook
   */
  fastify.post('/agents/me/notifications/test', async (request, reply) => {
    const preferences = await notificationService.getPreferences(request.agent.id);

    if (!preferences?.webhook_url) {
      return reply.status(400).send({ error: 'No webhook URL configured' });
    }

    const notificationId = await notificationService.queueNotification(
      request.agent.id,
      'test',
      {
        message: 'This is a test notification from BotHub',
        agent: request.agent.name,
      }
    );

    return {
      success: true,
      notification_id: notificationId,
      webhook_url: preferences.webhook_url,
    };
  });
}

export default notificationRoutes;
