/**
 * WebSocket Service
 * Handles real-time activity broadcasting for the dashboard
 */

class WebSocketService {
  constructor(redis) {
    this.redis = redis;
    this.clients = new Set();
    this.subscriber = null;
    this.channel = 'bothub:activity';
  }

  /**
   * Initialize Redis pub/sub for cross-pod messaging
   */
  async init() {
    if (!this.redis) return;

    // Create separate connection for subscriber (required by ioredis)
    this.subscriber = this.redis.duplicate();

    await this.subscriber.subscribe(this.channel);

    this.subscriber.on('message', (channel, message) => {
      if (channel === this.channel) {
        this.broadcastToLocal(message);
      }
    });
  }

  /**
   * Register a WebSocket connection
   */
  addClient(socket) {
    this.clients.add(socket);

    socket.on('close', () => {
      this.clients.delete(socket);
    });

    // Send welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      data: { message: 'Connected to BotHub activity feed' }
    }));

    // Set up ping/pong for connection health
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  }

  /**
   * Broadcast to all local clients
   */
  broadcastToLocal(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  /**
   * Publish activity event (goes to all pods via Redis)
   */
  async publishActivity(event) {
    const message = JSON.stringify({
      type: 'activity',
      data: {
        ...event,
        timestamp: event.timestamp || new Date().toISOString()
      }
    });

    if (this.redis) {
      await this.redis.publish(this.channel, message);
    } else {
      // No Redis, broadcast locally only
      this.broadcastToLocal(message);
    }
  }

  /**
   * Get current connection count
   */
  getConnectionCount() {
    return this.clients.size;
  }

  /**
   * Cleanup on shutdown
   */
  async close() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(this.channel);
      this.subscriber.disconnect();
    }

    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}

export default WebSocketService;
