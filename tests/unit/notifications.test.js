import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../../src/services/notifications.js';

describe('NotificationService', () => {
  let notificationService;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };
    mockRedis = {
      lpush: vi.fn(),
      rpop: vi.fn(),
      zadd: vi.fn(),
      zrangebyscore: vi.fn().mockResolvedValue([]),
      zrem: vi.fn(),
    };
    notificationService = new NotificationService(mockDb, mockRedis);
  });

  describe('queueNotification', () => {
    it('should check notification preferences before queueing', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await notificationService.queueNotification(
        'agent_1',
        'mention',
        { message: 'test' }
      );

      expect(result).toBeNull();
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('notification_preferences'),
        ['agent_1']
      );
    });

    it('should not queue if agent has no webhook URL', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ webhook_url: null, events: ['mention'] }]
      });

      const result = await notificationService.queueNotification(
        'agent_1',
        'mention',
        { message: 'test' }
      );

      expect(result).toBeNull();
    });

    it('should not queue if agent does not want this event type', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ webhook_url: 'https://example.com', events: ['reply'] }]
      });

      const result = await notificationService.queueNotification(
        'agent_1',
        'mention',
        { message: 'test' }
      );

      expect(result).toBeNull();
    });

    it('should queue notification when preferences match', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ webhook_url: 'https://example.com', events: ['mention'] }]
        })
        .mockResolvedValueOnce({
          rows: [{ id: 'notification_1' }]
        });

      const result = await notificationService.queueNotification(
        'agent_1',
        'mention',
        { message: 'test' }
      );

      expect(result).toBe('notification_1');
      expect(mockRedis.lpush).toHaveBeenCalled();
    });

    it('should queue for "all" events preference', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ webhook_url: 'https://example.com', events: ['all'] }]
        })
        .mockResolvedValueOnce({
          rows: [{ id: 'notification_2' }]
        });

      const result = await notificationService.queueNotification(
        'agent_1',
        'patch_merged',
        { message: 'test' }
      );

      expect(result).toBe('notification_2');
    });
  });

  describe('getNotifications', () => {
    it('should return empty array if no db', async () => {
      const service = new NotificationService(null, mockRedis);
      const result = await service.getNotifications('agent_1');
      expect(result).toEqual([]);
    });

    it('should fetch notifications with pagination', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'n1', event_type: 'mention', delivered: true },
          { id: 'n2', event_type: 'reply', delivered: false },
        ]
      });

      const result = await notificationService.getNotifications('agent_1', {
        limit: 10,
        offset: 0,
      });

      expect(result).toHaveLength(2);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('agent_notifications'),
        expect.arrayContaining(['agent_1'])
      );
    });

    it('should filter undelivered only', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await notificationService.getNotifications('agent_1', {
        undelivered_only: true,
      });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('delivered = false'),
        expect.any(Array)
      );
    });
  });

  describe('updatePreferences', () => {
    it('should return false if no db', async () => {
      const service = new NotificationService(null, mockRedis);
      const result = await service.updatePreferences('agent_1', 'https://example.com', ['mention']);
      expect(result).toBe(false);
    });

    it('should upsert preferences', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await notificationService.updatePreferences(
        'agent_1',
        'https://example.com/webhook',
        ['mention', 'reply']
      );

      expect(result).toBe(true);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.arrayContaining(['agent_1', 'https://example.com/webhook'])
      );
    });
  });

  describe('getPreferences', () => {
    it('should return null if no db', async () => {
      const service = new NotificationService(null, mockRedis);
      const result = await service.getPreferences('agent_1');
      expect(result).toBeNull();
    });

    it('should return null if no preferences found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      const result = await notificationService.getPreferences('agent_1');
      expect(result).toBeNull();
    });

    it('should return preferences if found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ webhook_url: 'https://example.com', events: ['mention'] }]
      });

      const result = await notificationService.getPreferences('agent_1');
      expect(result.webhook_url).toBe('https://example.com');
    });
  });

  describe('notification helpers', () => {
    beforeEach(() => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ webhook_url: 'https://example.com', events: ['all'] }]
        })
        .mockResolvedValueOnce({
          rows: [{ id: 'notification_x' }]
        });
    });

    it('should notify about mentions', async () => {
      const result = await notificationService.notifyMention(
        'agent_1',
        'other_agent',
        { post_id: 'post_1' }
      );

      expect(result).toBe('notification_x');
    });

    it('should notify about patch reviews', async () => {
      const result = await notificationService.notifyPatchReview(
        'agent_1',
        'reviewer',
        'patch_1',
        'approve'
      );

      expect(result).toBe('notification_x');
    });

    it('should notify about patch merges', async () => {
      const result = await notificationService.notifyPatchMerged(
        'agent_1',
        'patch_1',
        'forge_name'
      );

      expect(result).toBe('notification_x');
    });

    it('should notify about bounty claims', async () => {
      const result = await notificationService.notifyBountyClaimed(
        'agent_1',
        'claimer',
        'bounty_1'
      );

      expect(result).toBe('notification_x');
    });
  });

  describe('worker', () => {
    it('should start and stop worker', () => {
      notificationService.startWorker(1000);
      expect(notificationService.workerInterval).toBeDefined();

      notificationService.stopWorker();
      expect(notificationService.workerInterval).toBeNull();
    });
  });
});
