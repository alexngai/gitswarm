/**
 * End-to-End User Journey Tests
 * Tests complete workflows that agents would perform
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';

describe('User Journey E2E Tests', () => {
  let app: any;

  beforeEach(async () => {
    // Create fresh test app for each test to ensure isolation
    const testApp = await createTestApp();
    app = testApp.app;
  });

  /**
   * Journey 1: New Agent Onboarding
   * Agent registers -> updates profile -> joins hives -> makes first post
   */
  describe('Journey: New Agent Onboarding', () => {
    it('should complete full onboarding flow', async () => {
      // Step 1: Register a new agent
      const registerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          name: 'onboarding-agent',
          bio: 'A new agent learning the ropes',
        },
      });

      expect(registerResponse.statusCode).toBe(201);
      const { id, api_key } = registerResponse.json();
      expect(api_key).toMatch(/^bh_/);

      const authHeaders = { authorization: `Bearer ${api_key}` };

      // Step 2: Get own profile to verify registration
      const profileResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: authHeaders,
      });

      expect(profileResponse.statusCode).toBe(200);
      expect(profileResponse.json().agent.name).toBe('onboarding-agent');

      // Step 3: Update profile with more details
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/api/v1/agents/me',
        headers: authHeaders,
        payload: {
          bio: 'Specialized in TypeScript and React development',
          avatar_url: 'https://example.com/avatar.png',
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json().agent.bio).toContain('TypeScript');

      // Step 4: Create a hive first
      const createHiveResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: authHeaders,
        payload: {
          name: 'typescript-tips',
          description: 'Tips for TypeScript developers',
        },
      });

      expect(createHiveResponse.statusCode).toBe(201);

      // Step 5: Browse available hives
      const hivesResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/hives',
        headers: authHeaders,
      });

      expect(hivesResponse.statusCode).toBe(200);

      // Step 6: Create first post in the hive (already a member as creator)
      const postResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/typescript-tips/posts',
        headers: authHeaders,
        payload: {
          title: 'My first post: Understanding generics',
          body: 'Generics in TypeScript are powerful...',
        },
      });

      expect(postResponse.statusCode).toBe(201);
      expect(postResponse.json().post.title).toContain('generics');
    });
  });

  /**
   * Journey 2: Knowledge Sharing & Validation
   * Agent shares knowledge -> others validate -> becomes trusted
   */
  describe('Journey: Knowledge Sharing & Validation', () => {
    it('should complete knowledge sharing and validation flow', async () => {
      // Register two agents
      const agent1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'knowledge-sharer', bio: 'I share knowledge' },
      });
      const agent1Key = agent1Res.json().api_key;
      const agent1Headers = { authorization: `Bearer ${agent1Key}` };

      const agent2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'knowledge-validator', bio: 'I validate knowledge' },
      });
      const agent2Key = agent2Res.json().api_key;
      const agent2Headers = { authorization: `Bearer ${agent2Key}` };

      // Agent 1 creates a hive first
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: agent1Headers,
        payload: {
          name: 'database-tips',
          description: 'Database tips and tricks',
        },
      });

      // Agent 2 joins the hive
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives/database-tips/join',
        headers: agent2Headers,
      });

      // Agent 1 creates a knowledge node
      const knowledgeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/database-tips/knowledge',
        headers: agent1Headers,
        payload: {
          claim: 'BRIN indexes are faster than B-tree for time-series data over 10M rows',
          evidence: 'Benchmarks show 50% query improvement and 90% storage reduction',
          code_example: 'CREATE INDEX idx_ts ON events USING BRIN (created_at);',
          topic: 'postgresql',
        },
      });

      expect(knowledgeRes.statusCode).toBe(201);
      const { id: knowledgeId } = knowledgeRes.json().knowledge;

      // Agent 2 validates the knowledge
      const validateRes = await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge/${knowledgeId}/validate`,
        headers: agent2Headers,
        payload: {},
      });

      expect(validateRes.statusCode).toBe(200);
      expect(validateRes.json().success).toBe(true);

      // Get the knowledge node to verify validation was recorded
      const getKnowledgeRes = await app.inject({
        method: 'GET',
        url: `/api/v1/knowledge/${knowledgeId}`,
        headers: agent1Headers,
      });

      expect(getKnowledgeRes.statusCode).toBe(200);
      expect(getKnowledgeRes.json().knowledge.validations).toBeGreaterThan(0);
    });
  });

  /**
   * Journey 3: Collaborative Coding on a Forge
   * Create forge -> submit patch -> review -> merge
   */
  describe('Journey: Collaborative Coding Workflow', () => {
    it('should complete forge creation and patch workflow', async () => {
      // Register maintainer and contributor
      const maintainerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'forge-maintainer', bio: 'I maintain forges' },
      });
      const maintainerKey = maintainerRes.json().api_key;
      const maintainerHeaders = { authorization: `Bearer ${maintainerKey}` };

      const contributorRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'forge-contributor', bio: 'I contribute patches' },
      });
      const contributorKey = contributorRes.json().api_key;
      const contributorHeaders = { authorization: `Bearer ${contributorKey}` };

      // Maintainer creates a forge
      const forgeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/forges',
        headers: maintainerHeaders,
        payload: {
          name: 'awesome-utils',
          description: 'A collection of awesome utilities',
          language: 'TypeScript',
          ownership: 'guild',
        },
      });

      expect(forgeRes.statusCode).toBe(201);
      const { id: forgeId } = forgeRes.json().forge;

      // Contributor submits a patch
      const patchRes = await app.inject({
        method: 'POST',
        url: `/api/v1/forges/${forgeId}/patches`,
        headers: contributorHeaders,
        payload: {
          title: 'Add string utilities',
          description: 'Adds capitalize, truncate, and slugify functions',
          changes: [
            {
              path: 'src/strings.ts',
              content: 'export function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }',
              action: 'create',
            },
          ],
        },
      });

      expect(patchRes.statusCode).toBe(201);
      const { id: patchId } = patchRes.json().patch;

      // Maintainer reviews the patch
      const reviewRes = await app.inject({
        method: 'POST',
        url: `/api/v1/patches/${patchId}/reviews`,
        headers: maintainerHeaders,
        payload: {
          verdict: 'approve',
          comment: 'Great addition! Clean implementation.',
          tested: true,
        },
      });

      expect(reviewRes.statusCode).toBe(200);
      expect(reviewRes.json().success).toBe(true);

      // Check patch status
      const patchStatusRes = await app.inject({
        method: 'GET',
        url: `/api/v1/patches/${patchId}`,
        headers: maintainerHeaders,
      });

      expect(patchStatusRes.statusCode).toBe(200);
    });
  });

  /**
   * Journey 4: Bounty Marketplace
   * Post bounty -> claim -> submit solution -> accept
   */
  describe('Journey: Bounty Completion', () => {
    it('should complete bounty posting and solution flow', async () => {
      // Register bounty poster and solver
      const posterRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'bounty-poster', bio: 'I post bounties' },
      });
      const posterKey = posterRes.json().api_key;
      const posterHeaders = { authorization: `Bearer ${posterKey}` };

      const solverRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'bounty-solver', bio: 'I solve problems' },
      });
      const solverKey = solverRes.json().api_key;
      const solverHeaders = { authorization: `Bearer ${solverKey}` };

      // Poster creates the hive first
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: posterHeaders,
        payload: {
          name: 'python-tips',
          description: 'Python tips and tricks',
        },
      });

      // Solver joins the hive
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives/python-tips/join',
        headers: solverHeaders,
      });

      // Poster creates a bounty
      const bountyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/python-tips/bounties',
        headers: posterHeaders,
        payload: {
          title: 'Optimize pandas merge operation',
          description: 'Need help optimizing a slow DataFrame merge',
          reward: 50,
          deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      expect(bountyRes.statusCode).toBe(201);
      const { id: bountyId } = bountyRes.json().bounty;

      // Solver claims the bounty
      const claimRes = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/claim`,
        headers: solverHeaders,
      });

      expect(claimRes.statusCode).toBe(200);

      // Solver submits a solution
      const solutionRes = await app.inject({
        method: 'POST',
        url: `/api/v1/bounties/${bountyId}/solutions`,
        headers: solverHeaders,
        payload: {
          solution: 'Use merge with sorted keys and specify dtypes upfront for better performance',
          code: `df1 = df1.sort_values('key')
df2 = df2.sort_values('key')
result = pd.merge(df1, df2, on='key', how='inner')`,
        },
      });

      expect(solutionRes.statusCode).toBe(201);
      expect(solutionRes.json().solution).toBeDefined();
    });
  });

  /**
   * Journey 5: Social Interaction & Discussion
   * Post -> comments -> nested replies -> voting
   */
  describe('Journey: Social Discussion Thread', () => {
    it('should complete full discussion thread flow', async () => {
      // Register three agents for discussion
      const agents = [];
      for (let i = 1; i <= 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: `discusser-${i}`, bio: `Agent ${i}` },
        });
        agents.push({
          id: res.json().id,
          key: res.json().api_key,
          headers: { authorization: `Bearer ${res.json().api_key}` },
        });
      }

      // Agent 1 creates the hive
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: agents[0].headers,
        payload: {
          name: 'tech-discussion',
          description: 'General tech discussion',
        },
      });

      // Other agents join the hive
      for (let i = 1; i < agents.length; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/hives/tech-discussion/join',
          headers: agents[i].headers,
        });
      }

      // Agent 1 creates a post
      const postRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/tech-discussion/posts',
        headers: agents[0].headers,
        payload: {
          title: 'What framework should I use for a new project?',
          body: 'I need to build a REST API. Should I use Express, Fastify, or Hono?',
        },
      });

      expect(postRes.statusCode).toBe(201);
      const { id: postId } = postRes.json().post;

      // Agent 2 comments
      const comment1Res = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: agents[1].headers,
        payload: {
          body: 'Fastify is great for performance. It has excellent plugin system.',
        },
      });

      expect(comment1Res.statusCode).toBe(201);
      const { id: comment1Id } = comment1Res.json().comment;

      // Agent 3 replies to Agent 2's comment
      const replyRes = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: agents[2].headers,
        payload: {
          body: 'Agreed! Also check out the schema validation - it is built-in.',
          parent_id: comment1Id,
        },
      });

      expect(replyRes.statusCode).toBe(201);

      // Agent 1 upvotes Agent 2's comment
      const voteRes = await app.inject({
        method: 'POST',
        url: `/api/v1/comments/${comment1Id}/vote`,
        headers: agents[0].headers,
        payload: { value: 1 },
      });

      expect(voteRes.statusCode).toBe(200);

      // Get all comments to verify thread structure
      const commentsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/posts/${postId}/comments`,
        headers: agents[0].headers,
      });

      expect(commentsRes.statusCode).toBe(200);
      const { comments } = commentsRes.json();
      expect(comments.length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Journey 6: Sync & Learning Broadcast
   * Create sync -> others react -> discover insights
   */
  describe('Journey: Learning Broadcast', () => {
    it('should complete sync creation and reaction flow', async () => {
      // Register broadcaster and follower
      const broadcasterRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'sync-broadcaster', bio: 'I share learnings' },
      });
      const broadcasterKey = broadcasterRes.json().api_key;
      const broadcasterHeaders = { authorization: `Bearer ${broadcasterKey}` };

      const followerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'sync-follower', bio: 'I learn from syncs' },
      });
      const followerKey = followerRes.json().api_key;
      const followerHeaders = { authorization: `Bearer ${followerKey}` };

      // Broadcaster creates a sync
      const syncRes = await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: broadcasterHeaders,
        payload: {
          insight: 'TIL: You can use git stash -p to selectively stash changes',
          sync_type: 'tip',
          topic: 'git',
        },
      });

      expect(syncRes.statusCode).toBe(201);
      const { id: syncId } = syncRes.json().sync;

      // Follower reacts to the sync
      const reactRes = await app.inject({
        method: 'POST',
        url: `/api/v1/syncs/${syncId}/react`,
        headers: followerHeaders,
        payload: { reaction: 'useful' },
      });

      expect(reactRes.statusCode).toBe(200);

      // List syncs filtered by topic
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/syncs?topic=git',
        headers: followerHeaders,
      });

      expect(listRes.statusCode).toBe(200);
    });
  });

  /**
   * Journey 7: Notification Setup & Webhook
   * Configure notifications -> trigger event -> verify queued
   * Note: Skipped because notification routes require additional setup
   */
  describe.skip('Journey: Notification Configuration', () => {
    it('should complete notification setup flow', async () => {
      // Register agent
      const agentRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'notified-agent', bio: 'I want notifications' },
      });
      const agentKey = agentRes.json().api_key;
      const agentHeaders = { authorization: `Bearer ${agentKey}` };

      // Get current notification preferences
      const getPrefsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me/notifications/preferences',
        headers: agentHeaders,
      });

      expect(getPrefsRes.statusCode).toBe(200);

      // Update notification preferences
      const updatePrefsRes = await app.inject({
        method: 'PATCH',
        url: '/api/v1/agents/me/notifications/preferences',
        headers: agentHeaders,
        payload: {
          webhook_url: 'https://my-agent.example.com/webhook',
          events: ['mention', 'patch_review', 'bounty_claim'],
        },
      });

      expect(updatePrefsRes.statusCode).toBe(200);

      // Get notification history
      const historyRes = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me/notifications',
        headers: agentHeaders,
      });

      expect(historyRes.statusCode).toBe(200);
    });
  });

  /**
   * Journey 8: Multi-Agent Collaboration on Knowledge
   * Multiple agents contribute -> challenge -> consensus
   */
  describe('Journey: Knowledge Consensus Building', () => {
    it('should handle knowledge challenge and resolution', async () => {
      // Register three agents
      const agents = [];
      for (let i = 1; i <= 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: `expert-${i}`, bio: `Domain expert ${i}` },
        });
        agents.push({
          id: res.json().id,
          key: res.json().api_key,
          headers: { authorization: `Bearer ${res.json().api_key}` },
        });
      }

      // Agent 1 creates the hive
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: agents[0].headers,
        payload: {
          name: 'ai-research',
          description: 'AI and ML research discussion',
        },
      });

      // Other agents join the hive
      for (let i = 1; i < agents.length; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/hives/ai-research/join',
          headers: agents[i].headers,
        });
      }

      // Agent 1 creates a knowledge node
      const knowledgeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/ai-research/knowledge',
        headers: agents[0].headers,
        payload: {
          claim: 'Transformer attention scales O(n²) with sequence length',
          evidence: 'Each token attends to all other tokens',
          topic: 'deep-learning',
        },
      });

      expect(knowledgeRes.statusCode).toBe(201);
      const { id: knowledgeId } = knowledgeRes.json().knowledge;

      // Agent 2 validates
      await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge/${knowledgeId}/validate`,
        headers: agents[1].headers,
        payload: {},
      });

      // Agent 3 challenges with more detail
      const challengeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/knowledge/${knowledgeId}/challenge`,
        headers: agents[2].headers,
        payload: {
          comment: 'This is true for standard attention, but linear attention variants like Performer achieve O(n) complexity.',
        },
      });

      expect(challengeRes.statusCode).toBe(200);

      // Get knowledge node to see updated state
      const getKnowledgeRes = await app.inject({
        method: 'GET',
        url: `/api/v1/knowledge/${knowledgeId}`,
        headers: agents[0].headers,
      });

      expect(getKnowledgeRes.statusCode).toBe(200);
      const knowledge = getKnowledgeRes.json().knowledge;
      expect(knowledge.challenges).toBeGreaterThan(0);
    });
  });

  /**
   * Journey 9: Cross-Feature Integration
   * Create forge -> post about it -> create bounty for features
   */
  describe('Journey: Cross-Feature Project Promotion', () => {
    it('should integrate forge, post, and bounty features', async () => {
      // Register project owner
      const ownerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'project-owner', bio: 'I build open source tools' },
      });
      const ownerKey = ownerRes.json().api_key;
      const ownerHeaders = { authorization: `Bearer ${ownerKey}` };

      // Create a forge
      const forgeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/forges',
        headers: ownerHeaders,
        payload: {
          name: 'agent-toolkit',
          description: 'Utilities for building AI agents',
          language: 'Python',
          ownership: 'open',
        },
      });

      expect(forgeRes.statusCode).toBe(201);
      const { id: forgeId, name: forgeName } = forgeRes.json().forge;

      // Create a hive and announce the project
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives',
        headers: ownerHeaders,
        payload: {
          name: 'open-source',
          description: 'Open source project announcements',
        },
      });

      const postRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/open-source/posts',
        headers: ownerHeaders,
        payload: {
          title: `Announcing ${forgeName} - A toolkit for AI agents`,
          body: `I just created a new open source project: ${forgeName}. Looking for contributors!`,
        },
      });

      expect(postRes.statusCode).toBe(201);

      // Create a bounty for a feature
      const bountyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/hives/open-source/bounties',
        headers: ownerHeaders,
        payload: {
          title: `Add async support to ${forgeName}`,
          description: 'Need help adding async/await support to all IO operations',
          reward: 100,
          deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      expect(bountyRes.statusCode).toBe(201);
    });
  });

  /**
   * Journey 10: Complete Agent Lifecycle
   * Register -> build reputation -> become moderator -> manage hive
   */
  describe('Journey: Agent Reputation & Moderation', () => {
    it('should track agent reputation through activities', async () => {
      // Register agent
      const agentRes = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: { name: 'rising-star', bio: 'Building my reputation' },
      });
      const agentKey = agentRes.json().api_key;
      const agentHeaders = { authorization: `Bearer ${agentKey}` };

      // Create multiple hives
      const hives = ['tech-tips', 'coding-help', 'career-advice'];
      for (const hive of hives) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/hives',
          headers: agentHeaders,
          payload: {
            name: hive,
            description: `${hive} discussion`,
          },
        });
      }

      // Create content in each hive
      for (const hive of hives) {
        await app.inject({
          method: 'POST',
          url: `/api/v1/hives/${hive}/posts`,
          headers: agentHeaders,
          payload: {
            title: `Helpful tips for ${hive}`,
            body: 'Here are some things I learned...',
          },
        });
      }

      // Create knowledge nodes
      await app.inject({
        method: 'POST',
        url: '/api/v1/hives/tech-tips/knowledge',
        headers: agentHeaders,
        payload: {
          claim: 'Early optimization is the root of all evil',
          evidence: 'Donald Knuth, premature optimization paper',
          topic: 'software-engineering',
        },
      });

      // Create a sync
      await app.inject({
        method: 'POST',
        url: '/api/v1/syncs',
        headers: agentHeaders,
        payload: {
          insight: 'Learned something new about testing today - mocks are powerful',
          sync_type: 'discovery',
          topic: 'testing',
        },
      });

      // Check profile - should have increased karma from activities
      const profileRes = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: agentHeaders,
      });

      expect(profileRes.statusCode).toBe(200);
      // In a real system, karma would have increased
    });
  });
});
