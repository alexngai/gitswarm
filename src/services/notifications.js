/**
 * Notification Service
 * Handles webhook delivery and notification management for agents
 */

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 30000]; // 1s, 5s, 30s

export class NotificationService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.processing = false;
  }

  /**
   * Queue a notification for an agent
   */
  async queueNotification(agentId, eventType, payload) {
    if (!this.db) {
      return null;
    }

    // Check if agent has webhook configured and wants this event type
    const prefsResult = await this.db.query(`
      SELECT webhook_url, events
      FROM notification_preferences
      WHERE agent_id = $1
    `, [agentId]);

    if (prefsResult.rows.length === 0) {
      return null;
    }

    const prefs = prefsResult.rows[0];

    // Check if agent wants this event type
    const events = prefs.events || [];
    if (!events.includes(eventType) && !events.includes('all')) {
      return null;
    }

    if (!prefs.webhook_url) {
      return null;
    }

    // Create notification record
    const result = await this.db.query(`
      INSERT INTO agent_notifications (agent_id, event_type, payload)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [agentId, eventType, JSON.stringify(payload)]);

    const notificationId = result.rows[0].id;

    // Queue for delivery if using Redis
    if (this.redis) {
      await this.redis.lpush('notification_queue', JSON.stringify({
        id: notificationId,
        agent_id: agentId,
        webhook_url: prefs.webhook_url,
        event_type: eventType,
        payload,
        retries: 0,
      }));
    } else {
      // Immediate delivery attempt without queue
      this.deliverNotification(notificationId, prefs.webhook_url, eventType, payload);
    }

    return notificationId;
  }

  /**
   * Deliver a single notification via webhook
   */
  async deliverNotification(notificationId, webhookUrl, eventType, payload, retries = 0) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BotHub-Event': eventType,
          'X-BotHub-Delivery': notificationId,
        },
        body: JSON.stringify({
          event: eventType,
          payload,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (response.ok) {
        // Mark as delivered
        if (this.db) {
          await this.db.query(`
            UPDATE agent_notifications
            SET delivered = true, delivered_at = NOW()
            WHERE id = $1
          `, [notificationId]);
        }
        return true;
      }

      throw new Error(`Webhook returned ${response.status}`);
    } catch (error) {
      console.error(`Notification delivery failed (attempt ${retries + 1}):`, error.message);

      // Retry if under limit
      if (retries < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retries] || RETRY_DELAYS[RETRY_DELAYS.length - 1];

        if (this.redis) {
          // Re-queue with delay
          await this.redis.zadd('notification_retry', Date.now() + delay, JSON.stringify({
            id: notificationId,
            webhook_url: webhookUrl,
            event_type: eventType,
            payload,
            retries: retries + 1,
          }));
        } else {
          // Simple setTimeout retry
          setTimeout(() => {
            this.deliverNotification(notificationId, webhookUrl, eventType, payload, retries + 1);
          }, delay);
        }
      }

      return false;
    }
  }

  /**
   * Process notification queue (call from worker)
   */
  async processQueue() {
    if (!this.redis || this.processing) {
      return;
    }

    this.processing = true;

    try {
      // Process pending notifications
      while (true) {
        const item = await this.redis.rpop('notification_queue');
        if (!item) break;

        const notification = JSON.parse(item);
        await this.deliverNotification(
          notification.id,
          notification.webhook_url,
          notification.event_type,
          notification.payload,
          notification.retries
        );
      }

      // Process retries that are due
      const now = Date.now();
      const dueRetries = await this.redis.zrangebyscore('notification_retry', 0, now);

      for (const item of dueRetries) {
        const notification = JSON.parse(item);
        await this.redis.zrem('notification_retry', item);
        await this.deliverNotification(
          notification.id,
          notification.webhook_url,
          notification.event_type,
          notification.payload,
          notification.retries
        );
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Start background worker for processing notifications
   */
  startWorker(intervalMs = 5000) {
    this.workerInterval = setInterval(() => {
      this.processQueue().catch(console.error);
    }, intervalMs);
  }

  /**
   * Stop background worker
   */
  stopWorker() {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }

  /**
   * Get notifications for an agent
   */
  async getNotifications(agentId, options = {}) {
    const { limit = 50, offset = 0, undelivered_only = false } = options;

    if (!this.db) {
      return [];
    }

    let query = `
      SELECT id, event_type, payload, delivered, delivered_at, created_at
      FROM agent_notifications
      WHERE agent_id = $1
    `;

    const params = [agentId];

    if (undelivered_only) {
      query += ' AND delivered = false';
    }

    query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * Update notification preferences for an agent
   */
  async updatePreferences(agentId, webhookUrl, events) {
    if (!this.db) {
      return false;
    }

    await this.db.query(`
      INSERT INTO notification_preferences (agent_id, webhook_url, events, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        webhook_url = EXCLUDED.webhook_url,
        events = EXCLUDED.events,
        updated_at = NOW()
    `, [agentId, webhookUrl, JSON.stringify(events)]);

    return true;
  }

  /**
   * Get notification preferences for an agent
   */
  async getPreferences(agentId) {
    if (!this.db) {
      return null;
    }

    const result = await this.db.query(`
      SELECT webhook_url, events, created_at, updated_at
      FROM notification_preferences
      WHERE agent_id = $1
    `, [agentId]);

    return result.rows[0] || null;
  }

  /**
   * Notify about specific events
   */
  async notifyMention(mentionedAgentId, mentionerName, context) {
    return this.queueNotification(mentionedAgentId, 'mention', {
      mentioner: mentionerName,
      ...context,
    });
  }

  async notifyPatchReview(authorAgentId, reviewerName, patchId, verdict) {
    return this.queueNotification(authorAgentId, 'patch_review', {
      reviewer: reviewerName,
      patch_id: patchId,
      verdict,
    });
  }

  async notifyPatchMerged(authorAgentId, patchId, forgeName) {
    return this.queueNotification(authorAgentId, 'patch_merged', {
      patch_id: patchId,
      forge: forgeName,
    });
  }

  async notifyBountyClaimed(posterAgentId, claimerName, bountyId) {
    return this.queueNotification(posterAgentId, 'bounty_claim', {
      claimer: claimerName,
      bounty_id: bountyId,
    });
  }

  async notifyBountySolved(posterAgentId, solverName, bountyId, solutionId) {
    return this.queueNotification(posterAgentId, 'bounty_solved', {
      solver: solverName,
      bounty_id: bountyId,
      solution_id: solutionId,
    });
  }

  async notifyReply(parentAuthorId, replierName, context) {
    return this.queueNotification(parentAuthorId, 'reply', {
      replier: replierName,
      ...context,
    });
  }
}

export default NotificationService;
