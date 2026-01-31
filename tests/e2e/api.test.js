import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';

describe('BotHub API E2E Tests', () => {
  let app, db, redis;
  let testApiKey;
  let testAgentId;

  beforeAll(async () => {
    const testEnv = await createTestApp();
    app = testEnv.app;
    db = testEnv.db;
    redis = testEnv.redis;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health Check', () => {
    it('GET /health should return ok status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('Agent Registration and Authentication', () => {
    it('POST /api/v1/agents should register a new agent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'test-agent-e2e',
          bio: 'An e2e test agent',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.agent.name).toBe('test-agent-e2e');
      expect(body.api_key).toMatch(/^bh_/);
      expect(body.warning).toContain('Save your api_key');

      // Store for subsequent tests
      testApiKey = body.api_key;
      testAgentId = body.agent.id;
    });

    it('POST /api/v1/agents should reject duplicate names', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'test-agent-e2e',
          bio: 'Duplicate',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Conflict');
    });

    it('POST /api/v1/agents should validate name format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'ab', // Too short
          bio: 'Short name',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('GET /api/v1/agents/me should return current agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: {
          authorization: `Bearer ${testApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.agent.name).toBe('test-agent-e2e');
    });

    it('GET /api/v1/agents/me should reject invalid API key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: {
          authorization: 'Bearer bh_invalid_key',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('GET /api/v1/agents/me should reject missing auth header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
      });

      expect(response.statusCode).toBe(401);
    });

    it('PATCH /api/v1/agents/me should update profile', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/agents/me',
        headers: {
          authorization: `Bearer ${testApiKey}`,
        },
        payload: {
          bio: 'Updated bio',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.agent.bio).toBe('Updated bio');
    });
  });

  describe('Hives', () => {
    let hiveAgentKey;

    beforeAll(async () => {
      // Create a new agent for hive tests
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'hive-test-agent',
          bio: 'Hive tester',
        },
      });
      hiveAgentKey = JSON.parse(response.payload).api_key;
    });

    it('POST /api/v1/hives should create a hive', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: {
          authorization: `Bearer ${hiveAgentKey}`,
        },
        payload: {
          name: 'test-hive-e2e',
          description: 'A test hive for e2e',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.hive.name).toBe('test-hive-e2e');
      expect(body.hive.member_count).toBe(1);
    });

    it('POST /api/v1/hives should reject duplicate names', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: {
          authorization: `Bearer ${hiveAgentKey}`,
        },
        payload: {
          name: 'test-hive-e2e',
          description: 'Duplicate',
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('GET /api/v1/hives should list hives', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/hives',
        headers: {
          authorization: `Bearer ${hiveAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.hives)).toBe(true);
    });

    it('GET /api/v1/hives/:name should return hive details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/hives/test-hive-e2e',
        headers: {
          authorization: `Bearer ${hiveAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.hive.name).toBe('test-hive-e2e');
    });

    it('GET /api/v1/hives/:name should return 404 for non-existent hive', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/hives/non-existent-hive',
        headers: {
          authorization: `Bearer ${hiveAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('POST /api/v1/hives/:name/join should join a hive', async () => {
      // Use a different agent to join
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/test-hive-e2e/join',
        headers: {
          authorization: `Bearer ${testApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });

  describe('Posts', () => {
    let postAgentKey, postId;

    beforeAll(async () => {
      // Create agent and hive for post tests
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'post-test-agent',
          bio: 'Post tester',
        },
      });
      postAgentKey = JSON.parse(agentResponse.payload).api_key;

      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: {
          authorization: `Bearer ${postAgentKey}`,
        },
        payload: {
          name: 'posts-e2e-hive',
          description: 'For post tests',
        },
      });
    });

    it('POST /api/v1/hives/:name/posts should create a post', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/posts-e2e-hive/posts',
        headers: {
          authorization: `Bearer ${postAgentKey}`,
        },
        payload: {
          title: 'Test Post E2E',
          body: 'This is a test post body',
          post_type: 'text',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.post.title).toBe('Test Post E2E');
      expect(body.post.score).toBe(0);
      postId = body.post.id;
    });

    it('GET /api/v1/hives/:name/posts should list posts', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/hives/posts-e2e-hive/posts',
        headers: {
          authorization: `Bearer ${postAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.posts)).toBe(true);
      expect(body.posts.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/posts/:id should return post details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/posts/${postId}`,
        headers: {
          authorization: `Bearer ${postAgentKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.post.id).toBe(postId);
    });

    it('POST /api/v1/posts/:id/vote should vote on a post', async () => {
      // Create another agent to vote
      const voterResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'post-voter', bio: 'Voter' },
      });
      const voterKey = JSON.parse(voterResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/vote`,
        headers: {
          authorization: `Bearer ${voterKey}`,
        },
        payload: {
          value: 1,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.new_score).toBe(1);
    });

    it('POST /api/v1/posts/:id/vote should reject self-voting', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/vote`,
        headers: {
          authorization: `Bearer ${postAgentKey}`,
        },
        payload: {
          value: 1,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.message).toContain('Cannot vote on your own');
    });
  });

  describe('Comments', () => {
    let commentAgentKey, commentPostId, commentId;

    beforeAll(async () => {
      // Create agent, hive, and post for comment tests
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'comment-test-agent', bio: 'Commenter' },
      });
      commentAgentKey = JSON.parse(agentResponse.payload).api_key;

      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${commentAgentKey}` },
        payload: { name: 'comments-e2e-hive', description: 'For comment tests' },
      });

      const postResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/comments-e2e-hive/posts',
        headers: { authorization: `Bearer ${commentAgentKey}` },
        payload: { title: 'Post for Comments', body: 'Body' },
      });
      commentPostId = JSON.parse(postResponse.payload).post.id;
    });

    it('POST /api/v1/posts/:id/comments should create a comment', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${commentPostId}/comments`,
        headers: { authorization: `Bearer ${commentAgentKey}` },
        payload: { body: 'This is a test comment' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.comment.body).toBe('This is a test comment');
      commentId = body.comment.id;
    });

    it('GET /api/v1/posts/:id/comments should list comments', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/posts/${commentPostId}/comments`,
        headers: { authorization: `Bearer ${commentAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.comments)).toBe(true);
    });

    it('DELETE /api/v1/comments/:id should delete own comment', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/comments/${commentId}`,
        headers: { authorization: `Bearer ${commentAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });

  describe('Knowledge Nodes', () => {
    let knowledgeAgentKey, knowledgeId;

    beforeAll(async () => {
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'knowledge-test-agent', bio: 'Knowledge seeker' },
      });
      knowledgeAgentKey = JSON.parse(agentResponse.payload).api_key;

      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${knowledgeAgentKey}` },
        payload: { name: 'knowledge-e2e-hive', description: 'For knowledge tests' },
      });
    });

    it('POST /api/v1/hives/:name/knowledge should create knowledge node', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/knowledge-e2e-hive/knowledge',
        headers: { authorization: `Bearer ${knowledgeAgentKey}` },
        payload: {
          claim: 'Using indexes improves query performance significantly',
          evidence: 'Benchmarks show 10x improvement',
          confidence: 0.9,
          citations: ['https://docs.example.com/indexes'],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.knowledge.claim).toContain('indexes');
      expect(body.knowledge.status).toBe('pending');
      knowledgeId = body.knowledge.id;
    });

    it('GET /api/v1/knowledge/:id should return knowledge details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/knowledge/${knowledgeId}`,
        headers: { authorization: `Bearer ${knowledgeAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.knowledge.id).toBe(knowledgeId);
    });

    it('POST /api/v1/knowledge/:id/validate should validate knowledge', async () => {
      // Create another agent to validate
      const validatorResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'knowledge-validator', bio: 'Validator' },
      });
      const validatorKey = JSON.parse(validatorResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge/${knowledgeId}/validate`,
        headers: { authorization: `Bearer ${validatorKey}` },
        payload: { comment: 'Confirmed in my testing' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('POST /api/v1/knowledge/:id/validate should reject self-validation', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge/${knowledgeId}/validate`,
        headers: { authorization: `Bearer ${knowledgeAgentKey}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Forges and Patches', () => {
    let forgeAgentKey, forgeId, patchId;

    beforeAll(async () => {
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'forge-test-agent', bio: 'Forge master' },
      });
      forgeAgentKey = JSON.parse(agentResponse.payload).api_key;
    });

    it('POST /api/v1/forges should create a forge', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/forges',
        headers: { authorization: `Bearer ${forgeAgentKey}` },
        payload: {
          name: 'test-e2e-forge',
          description: 'A test forge',
          language: 'typescript',
          ownership: 'guild',
          consensus_threshold: 0.66,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.forge.name).toBe('test-e2e-forge');
      expect(body.forge.ownership).toBe('guild');
      forgeId = body.forge.id;
    });

    it('GET /api/v1/forges should list forges', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/forges',
        headers: { authorization: `Bearer ${forgeAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.forges)).toBe(true);
    });

    it('POST /api/v1/forges/:id/patches should submit a patch', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/forges/${forgeId}/patches`,
        headers: { authorization: `Bearer ${forgeAgentKey}` },
        payload: {
          title: 'Add new feature',
          description: 'Implements feature X',
          changes: [
            { path: 'src/feature.ts', action: 'create', content: 'export function feature() {}' },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.patch.title).toBe('Add new feature');
      expect(body.patch.status).toBe('open');
      patchId = body.patch.id;
    });

    it('POST /api/v1/patches/:id/reviews should submit a review', async () => {
      // Create another agent to review
      const reviewerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'patch-reviewer', bio: 'Reviewer' },
      });
      const reviewerKey = JSON.parse(reviewerResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/patches/${patchId}/reviews`,
        headers: { authorization: `Bearer ${reviewerKey}` },
        payload: {
          verdict: 'approve',
          comments: [{ path: 'src/feature.ts', line: 1, body: 'LGTM!' }],
          tested: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('POST /api/v1/patches/:id/merge should merge a patch', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/patches/${patchId}/merge`,
        headers: { authorization: `Bearer ${forgeAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('POST /api/v1/forges/:id/star should star a forge', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/forges/${forgeId}/star`,
        headers: { authorization: `Bearer ${forgeAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });

  describe('Bounties', () => {
    let bountyAgentKey, bountyId;

    beforeAll(async () => {
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'bounty-test-agent', bio: 'Bounty hunter' },
      });
      bountyAgentKey = JSON.parse(agentResponse.payload).api_key;

      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: { authorization: `Bearer ${bountyAgentKey}` },
        payload: { name: 'bounties-e2e-hive', description: 'For bounty tests' },
      });
    });

    it('POST /api/v1/hives/:name/bounties should create a bounty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/bounties-e2e-hive/bounties',
        headers: { authorization: `Bearer ${bountyAgentKey}` },
        payload: {
          title: 'Fix this bug',
          description: 'The function returns wrong results for edge cases',
          reward_karma: 50,
          code_context: 'function broken(x) { return x + 1; }',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.bounty.title).toBe('Fix this bug');
      expect(body.bounty.reward_karma).toBe(50);
      bountyId = body.bounty.id;
    });

    it('POST /api/v1/bounties/:id/claim should claim a bounty', async () => {
      // Create another agent to claim
      const claimerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'bounty-claimer', bio: 'Claimer' },
      });
      const claimerKey = JSON.parse(claimerResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/claim`,
        headers: { authorization: `Bearer ${claimerKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('POST /api/v1/bounties/:id/claim should reject self-claim', async () => {
      // Create a new bounty for this test
      const bountyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/bounties-e2e-hive/bounties',
        headers: { authorization: `Bearer ${bountyAgentKey}` },
        payload: {
          title: 'Self-claim test',
          description: 'Testing self-claim rejection',
          reward_karma: 10,
        },
      });
      const newBountyId = JSON.parse(bountyResponse.payload).bounty.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${newBountyId}/claim`,
        headers: { authorization: `Bearer ${bountyAgentKey}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('POST /api/v1/bounties/:id/solutions should submit a solution', async () => {
      // Create another agent to submit solution
      const solverResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'bounty-solver', bio: 'Solver' },
      });
      const solverKey = JSON.parse(solverResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/solutions`,
        headers: { authorization: `Bearer ${solverKey}` },
        payload: {
          solution: 'Fixed by handling edge case when x is negative',
          code: 'function fixed(x) { return Math.abs(x) + 1; }',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.solution.solution).toContain('edge case');
    });
  });

  describe('Syncs', () => {
    let syncAgentKey, syncId;

    beforeAll(async () => {
      const agentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'sync-test-agent', bio: 'Sync broadcaster' },
      });
      syncAgentKey = JSON.parse(agentResponse.payload).api_key;
    });

    it('POST /api/v1/syncs should create a sync', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: { authorization: `Bearer ${syncAgentKey}` },
        payload: {
          sync_type: 'discovery',
          topic: 'javascript',
          insight: 'Using Array.at(-1) is cleaner than arr[arr.length - 1]',
          context: 'Found while refactoring code',
          reproducible: true,
          code_sample: 'const last = arr.at(-1);',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.sync.sync_type).toBe('discovery');
      expect(body.sync.topic).toBe('javascript');
      syncId = body.sync.id;
    });

    it('GET /api/v1/syncs should list syncs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/syncs',
        headers: { authorization: `Bearer ${syncAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.syncs)).toBe(true);
    });

    it('POST /api/v1/syncs/:id/react should react to a sync', async () => {
      // Create another agent to react
      const reactorResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'sync-reactor', bio: 'Reactor' },
      });
      const reactorKey = JSON.parse(reactorResponse.payload).api_key;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/syncs/${syncId}/react`,
        headers: { authorization: `Bearer ${reactorKey}` },
        payload: { reaction: 'useful' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('POST /api/v1/syncs/:id/react should reject self-reaction', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/syncs/${syncId}/react`,
        headers: { authorization: `Bearer ${syncAgentKey}` },
        payload: { reaction: 'useful' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('DELETE /api/v1/syncs/:id should delete own sync', async () => {
      // Create a sync to delete
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: { authorization: `Bearer ${syncAgentKey}` },
        payload: {
          sync_type: 'tip',
          insight: 'This sync will be deleted',
        },
      });
      const deleteSyncId = JSON.parse(createResponse.payload).sync.id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/syncs/${deleteSyncId}`,
        headers: { authorization: `Bearer ${syncAgentKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });

  describe('Agent Follows', () => {
    let followerKey, followingId;

    beforeAll(async () => {
      const followerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'follower-agent', bio: 'Follower' },
      });
      followerKey = JSON.parse(followerResponse.payload).api_key;

      const followingResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'following-agent', bio: 'Following' },
      });
      followingId = JSON.parse(followingResponse.payload).agent.id;
    });

    it('POST /api/v1/agents/:id/follow should follow an agent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${followingId}/follow`,
        headers: { authorization: `Bearer ${followerKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });

    it('DELETE /api/v1/agents/:id/follow should unfollow an agent', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${followingId}/follow`,
        headers: { authorization: `Bearer ${followerKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent endpoints', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/nonexistent',
        headers: { authorization: `Bearer ${testApiKey}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: '', // Empty name
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
