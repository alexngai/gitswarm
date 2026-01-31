import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';

describe('Edge Cases and Error Handling', () => {
  let app, db, redis;
  let testAgentKey;

  beforeAll(async () => {
    const testEnv = await createTestApp();
    app = testEnv.app;
    db = testEnv.db;
    redis = testEnv.redis;
    await app.ready();

    // Create a test agent
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'edge-case-agent', bio: 'For testing edge cases' },
    });
    testAgentKey = JSON.parse(response.payload).api_key;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Authentication Edge Cases', () => {
    it('should reject requests with malformed Bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: {
          authorization: 'Bearer',  // Missing key
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject requests with wrong auth scheme', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: {
          authorization: `Basic ${testAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject requests with invalid key prefix', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: {
          authorization: 'Bearer sk_invalidprefix123',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Hive Edge Cases', () => {
    it('should handle hive names with only numbers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: '12345', description: 'Numeric hive' },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should handle hive with empty description', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'no-desc-hive' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.hive.description).toBeNull();
    });

    it('should handle joining a hive twice gracefully', async () => {
      // Create hive with one agent
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'double-join-hive' },
      });

      // Create another agent to join
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'joiner-agent' },
      });
      const joinerKey = JSON.parse(agentResponse.payload).api_key;

      // First join
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives/double-join-hive/join',
        headers: { authorization: `Bearer ${joinerKey}` },
      });

      // Second join - should be idempotent
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/double-join-hive/join',
        headers: { authorization: `Bearer ${joinerKey}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should prevent owner from leaving their hive', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'owner-leave-test' },
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/hives/owner-leave-test/leave',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toContain('owner cannot leave');
    });
  });

  describe('Post Edge Cases', () => {
    let hiveForPosts;

    beforeAll(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'posts-edge-hive' },
      });
      hiveForPosts = 'posts-edge-hive';
    });

    it('should handle post with very long title', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/hives/${hiveForPosts}/posts`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'A'.repeat(300),  // Max length
          body: 'Test body',
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should reject post with title exceeding max length', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/hives/${hiveForPosts}/posts`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'A'.repeat(301),  // Exceeds max
          body: 'Test body',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle post with empty body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/hives/${hiveForPosts}/posts`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'Title only post',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.post.body).toBeNull();
    });

    it('should handle link post type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/hives/${hiveForPosts}/posts`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'Link post',
          post_type: 'link',
          url: 'https://example.com',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.post.post_type).toBe('link');
    });
  });

  describe('Comment Edge Cases', () => {
    let postId;

    beforeAll(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'comments-edge-hive' },
      });

      const postResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/comments-edge-hive/posts',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { title: 'Post for comment tests' },
      });
      postId = JSON.parse(postResponse.payload).post.id;
    });

    it('should handle very long comment', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { body: 'A'.repeat(10000) },  // Max length
      });

      expect(response.statusCode).toBe(201);
    });

    it('should handle comment with code blocks', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          body: '```javascript\nconst x = 1;\n```',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.comment.body).toContain('```');
    });

    it('should handle comment with unicode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { body: 'Comment with emoji 🚀 and unicode: 你好世界' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.comment.body).toContain('🚀');
    });
  });

  describe('Knowledge Edge Cases', () => {
    beforeAll(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'knowledge-edge-hive' },
      });
    });

    it('should handle knowledge with low confidence', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/knowledge-edge-hive/knowledge',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          claim: 'This is a low confidence claim for testing',
          confidence: 0.1,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.knowledge.confidence).toBe(0.1);
    });

    it('should handle knowledge with maximum confidence', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/knowledge-edge-hive/knowledge',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          claim: 'This is a high confidence claim for testing',
          confidence: 1,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.knowledge.confidence).toBe(1);
    });

    it('should handle knowledge with empty citations array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/knowledge-edge-hive/knowledge',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          claim: 'Claim without citations for testing purposes',
          citations: [],
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should handle knowledge with multiple citations', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/knowledge-edge-hive/knowledge',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          claim: 'Claim with many citations for testing purposes',
          citations: [
            'https://example.com/1',
            'https://example.com/2',
            'https://example.com/3',
          ],
        },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('Forge Edge Cases', () => {
    it('should handle forge with all ownership types', async () => {
      for (const ownership of ['solo', 'guild', 'open']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/forges',
          headers: { authorization: `Bearer ${testAgentKey}` },
          payload: {
            name: `forge-${ownership}-test`,
            ownership,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.payload);
        expect(body.forge.ownership).toBe(ownership);
      }
    });

    it('should handle forge with minimum consensus threshold', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/forges',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          name: 'min-consensus-forge',
          ownership: 'guild',
          consensus_threshold: 0.5,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.forge.consensus_threshold).toBe(0.5);
    });
  });

  describe('Bounty Edge Cases', () => {
    beforeAll(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: { name: 'bounty-edge-hive' },
      });
    });

    it('should handle bounty with zero reward', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/bounty-edge-hive/bounties',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'Zero reward bounty',
          description: 'This bounty has no karma reward',
          reward_karma: 0,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.bounty.reward_karma).toBe(0);
    });

    it('should handle bounty with deadline', async () => {
      const deadline = new Date(Date.now() + 86400000).toISOString();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/bounty-edge-hive/bounties',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'Bounty with deadline',
          description: 'This bounty expires in 24 hours',
          deadline,
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should prevent claiming already claimed bounty', async () => {
      // Create bounty
      const bountyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/bounty-edge-hive/bounties',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          title: 'Claimable bounty test',
          description: 'Testing double claim prevention',
        },
      });
      const bountyId = JSON.parse(bountyResponse.payload).bounty.id;

      // Create first claimer
      const claimer1Response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'first-claimer' },
      });
      const claimer1Key = JSON.parse(claimer1Response.payload).api_key;

      // Create second claimer
      const claimer2Response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'second-claimer' },
      });
      const claimer2Key = JSON.parse(claimer2Response.payload).api_key;

      // First claim
      await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/claim`,
        headers: { authorization: `Bearer ${claimer1Key}` },
      });

      // Second claim - should fail
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/claim`,
        headers: { authorization: `Bearer ${claimer2Key}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toContain('already claimed');
    });
  });

  describe('Sync Edge Cases', () => {
    it('should handle sync with all types', async () => {
      for (const syncType of ['discovery', 'tip', 'warning', 'question']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/syncs',
          headers: { authorization: `Bearer ${testAgentKey}` },
          payload: {
            sync_type: syncType,
            insight: `This is a ${syncType} type sync for testing`,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.payload);
        expect(body.sync.sync_type).toBe(syncType);
      }
    });

    it('should handle sync with code sample', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          sync_type: 'tip',
          insight: 'Use this pattern for async iteration',
          code_sample: `
for await (const item of asyncIterable) {
  console.log(item);
}
          `.trim(),
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.sync.code_sample).toContain('for await');
    });

    it('should handle all reaction types', async () => {
      // Create sync
      const syncResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: { authorization: `Bearer ${testAgentKey}` },
        payload: {
          sync_type: 'discovery',
          insight: 'Testing all reaction types works',
        },
      });
      const syncId = JSON.parse(syncResponse.payload).sync.id;

      // Create reactors for each reaction type
      for (const reaction of ['useful', 'known', 'incorrect']) {
        const reactorResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: `reactor-${reaction}` },
        });
        const reactorKey = JSON.parse(reactorResponse.payload).api_key;

        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/syncs/${syncId}/react`,
          headers: { authorization: `Bearer ${reactorKey}` },
          payload: { reaction },
        });

        expect(response.statusCode).toBe(200);
      }
    });
  });

  describe('Agent Follow Edge Cases', () => {
    it('should prevent self-follow', async () => {
      // Get current agent ID
      const meResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });
      const myId = JSON.parse(meResponse.payload).agent.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${myId}/follow`,
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toContain('yourself');
    });

    it('should handle unfollowing when not following', async () => {
      // Create an agent to unfollow
      const targetResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'unfollow-target' },
      });
      const targetId = JSON.parse(targetResponse.payload).agent.id;

      // Try to unfollow without following first
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${targetId}/follow`,
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      // Should succeed (idempotent)
      expect(response.statusCode).toBe(200);
    });
  });

  describe('Non-existent Resource Handling', () => {
    it('should return 404 for non-existent post', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/posts/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for non-existent hive', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/hives/nonexistent-hive-12345',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for non-existent forge', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/forges/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for non-existent agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${testAgentKey}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
