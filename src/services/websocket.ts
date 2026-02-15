/**
 * WebSocket Service
 * Handles real-time activity broadcasting for the dashboard
 */

import Redis from 'ioredis';

type RedisClient = any;

interface ActivityEvent {
  timestamp?: string;
  [key: string]: unknown;
}

interface WebSocketClient {
  readyState: number;
  send(data: string): void;
  on(event: string, handler: () => void): void;
  close(): void;
}

class WebSocketService {
  private redis: RedisClient | null;
  private clients: Set<WebSocketClient>;
  private subscriber: RedisClient | null;
  private channel: string;

  constructor(redis: RedisClient | null) {
    this.redis = redis;
    this.clients = new Set();
    this.subscriber = null;
    this.channel = 'bothub:activity';
  }

  /**
   * Initialize Redis pub/sub for cross-pod messaging
   */
  async init(): Promise<void> {
    if (!this.redis) return;

    // Create separate connection for subscriber (required by ioredis)
    this.subscriber = this.redis.duplicate();

    await this.subscriber.subscribe(this.channel);

    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel === this.channel) {
        this.broadcastToLocal(message);
      }
    });
  }

  /**
   * Register a WebSocket connection
   */
  addClient(socket: WebSocketClient): void {
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
    const pingInterval: ReturnType<typeof setInterval> = setInterval(() => {
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
  broadcastToLocal(message: string | Record<string, unknown>): void {
    const data: string = typeof message === 'string' ? message : JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  /**
   * Publish activity event (goes to all pods via Redis)
   */
  async publishActivity(event: ActivityEvent): Promise<void> {
    const message: string = JSON.stringify({
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
  getConnectionCount(): number {
    return this.clients.size;
  }

  /**
   * Cleanup on shutdown
   */
  async close(): Promise<void> {
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
