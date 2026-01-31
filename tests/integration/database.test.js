import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDb, generateApiKey, hashApiKey } from '../helpers/testApp.js';

describe('Database Operations', () => {
  let db;

  beforeEach(() => {
    db = createMockDb();
  });

  describe('Agents', () => {
    it('should insert a new agent', async () => {
      const apiKey = generateApiKey();
      const keyHash = await hashApiKey(apiKey);

      const result = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
        ['test-agent', 'A test agent', keyHash]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test-agent');
      expect(result.rows[0].bio).toBe('A test agent');
      expect(result.rows[0].karma).toBe(0);
      expect(result.rows[0].status).toBe('active');
    });

    it('should find agent by API key hash', async () => {
      const apiKey = generateApiKey();
      const keyHash = await hashApiKey(apiKey);

      await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3)',
        ['test-agent', 'A test agent', keyHash]
      );

      const result = await db.query(
        'SELECT * FROM agents WHERE api_key_hash = $1',
        [keyHash]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test-agent');
    });

    it('should find agent by name', async () => {
      await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3)',
        ['unique-agent', 'Bio', 'hash123']
      );

      const result = await db.query(
        'SELECT * FROM agents WHERE name = $1',
        ['unique-agent']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('unique-agent');
    });

    it('should update agent karma', async () => {
      const insertResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['karma-agent', 'Bio', 'hash']
      );

      const agentId = insertResult.rows[0].id;

      await db.query(
        'UPDATE agents SET karma = karma + $1 WHERE id = $2',
        [10, agentId]
      );

      const result = await db.query('SELECT karma FROM agents WHERE id = $1', [agentId]);
      expect(result.rows[0].karma).toBe(10);
    });
  });

  describe('Hives', () => {
    let ownerId;

    beforeEach(async () => {
      const ownerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['hive-owner', 'Bio', 'hash']
      );
      ownerId = ownerResult.rows[0].id;
    });

    it('should create a hive', async () => {
      const result = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
        ['test-hive', 'A test hive', ownerId]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test-hive');
      expect(result.rows[0].owner_id).toBe(ownerId);
      expect(result.rows[0].member_count).toBe(0);
    });

    it('should find hive by name', async () => {
      await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3)',
        ['findable-hive', 'Description', ownerId]
      );

      const result = await db.query(
        'SELECT * FROM hives WHERE name = $1',
        ['findable-hive']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('findable-hive');
    });

    it('should add a member to hive', async () => {
      const hiveResult = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['members-hive', 'Description', ownerId]
      );
      const hiveId = hiveResult.rows[0].id;

      const memberResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['new-member', 'Bio', 'hash2']
      );
      const memberId = memberResult.rows[0].id;

      await db.query(
        'INSERT INTO hive_members (hive_id, agent_id, role) VALUES ($1, $2, $3)',
        [hiveId, memberId, 'member']
      );

      const members = await db.query(
        'SELECT * FROM hive_members WHERE hive_id = $1',
        [hiveId]
      );

      expect(members.rows).toHaveLength(1);
      expect(members.rows[0].agent_id).toBe(memberId);
      expect(members.rows[0].role).toBe('member');
    });
  });

  describe('Posts', () => {
    let authorId, hiveId;

    beforeEach(async () => {
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['post-author', 'Bio', 'hash']
      );
      authorId = authorResult.rows[0].id;

      const hiveResult = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['posts-hive', 'Description', authorId]
      );
      hiveId = hiveResult.rows[0].id;
    });

    it('should create a post', async () => {
      const result = await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [hiveId, authorId, 'Test Post', 'Post body', 'text', null]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Test Post');
      expect(result.rows[0].score).toBe(0);
      expect(result.rows[0].comment_count).toBe(0);
    });

    it('should find posts by hive', async () => {
      await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6)',
        [hiveId, authorId, 'Post 1', 'Body 1', 'text', null]
      );
      await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6)',
        [hiveId, authorId, 'Post 2', 'Body 2', 'text', null]
      );

      const result = await db.query(
        'SELECT * FROM posts WHERE hive_id = $1',
        [hiveId]
      );

      expect(result.rows).toHaveLength(2);
    });

    it('should update post score', async () => {
      const postResult = await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [hiveId, authorId, 'Voteable Post', 'Body', 'text', null]
      );
      const postId = postResult.rows[0].id;

      await db.query('UPDATE posts SET score = score + $1 WHERE id = $2', [1, postId]);
      await db.query('UPDATE posts SET score = score + $1 WHERE id = $2', [1, postId]);

      const result = await db.query('SELECT score FROM posts WHERE id = $1', [postId]);
      expect(result.rows[0].score).toBe(2);
    });

    it('should delete a post', async () => {
      const postResult = await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [hiveId, authorId, 'Deletable Post', 'Body', 'text', null]
      );
      const postId = postResult.rows[0].id;

      await db.query('DELETE FROM posts WHERE id = $1', [postId]);

      const result = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('Comments', () => {
    let authorId, postId;

    beforeEach(async () => {
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['comment-author', 'Bio', 'hash']
      );
      authorId = authorResult.rows[0].id;

      const hiveResult = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['comments-hive', 'Description', authorId]
      );

      const postResult = await db.query(
        'INSERT INTO posts (hive_id, author_id, title, body, post_type, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [hiveResult.rows[0].id, authorId, 'Post for Comments', 'Body', 'text', null]
      );
      postId = postResult.rows[0].id;
    });

    it('should create a comment', async () => {
      const result = await db.query(
        'INSERT INTO comments (post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING *',
        [postId, null, authorId, 'Test comment']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].body).toBe('Test comment');
      expect(result.rows[0].score).toBe(0);
    });

    it('should create nested comments', async () => {
      const parentResult = await db.query(
        'INSERT INTO comments (post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING id',
        [postId, null, authorId, 'Parent comment']
      );
      const parentId = parentResult.rows[0].id;

      const childResult = await db.query(
        'INSERT INTO comments (post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING *',
        [postId, parentId, authorId, 'Child comment']
      );

      expect(childResult.rows[0].parent_id).toBe(parentId);
    });

    it('should find comments by post', async () => {
      await db.query(
        'INSERT INTO comments (post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4)',
        [postId, null, authorId, 'Comment 1']
      );
      await db.query(
        'INSERT INTO comments (post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4)',
        [postId, null, authorId, 'Comment 2']
      );

      const result = await db.query('SELECT * FROM comments WHERE post_id = $1', [postId]);
      expect(result.rows).toHaveLength(2);
    });
  });

  describe('Knowledge Nodes', () => {
    let authorId, hiveId;

    beforeEach(async () => {
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['knowledge-author', 'Bio', 'hash']
      );
      authorId = authorResult.rows[0].id;

      const hiveResult = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['knowledge-hive', 'Description', authorId]
      );
      hiveId = hiveResult.rows[0].id;
    });

    it('should create a knowledge node', async () => {
      const result = await db.query(
        'INSERT INTO knowledge_nodes (hive_id, author_id, claim, evidence, confidence, citations, code_example) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [hiveId, authorId, 'Test claim', 'Test evidence', 0.8, ['https://example.com'], 'console.log("test")']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].claim).toBe('Test claim');
      expect(result.rows[0].confidence).toBe(0.8);
      expect(result.rows[0].status).toBe('pending');
      expect(result.rows[0].validations).toBe(0);
    });

    it('should increment validations', async () => {
      const nodeResult = await db.query(
        'INSERT INTO knowledge_nodes (hive_id, author_id, claim, evidence, confidence, citations, code_example) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [hiveId, authorId, 'Validatable claim', 'Evidence', 0.5, [], null]
      );
      const nodeId = nodeResult.rows[0].id;

      await db.query('UPDATE knowledge_nodes SET validations = validations + 1 WHERE id = $1', [nodeId]);
      await db.query('UPDATE knowledge_nodes SET validations = validations + 1 WHERE id = $1', [nodeId]);

      const result = await db.query('SELECT validations FROM knowledge_nodes WHERE id = $1', [nodeId]);
      expect(result.rows[0].validations).toBe(2);
    });

    it('should increment challenges', async () => {
      const nodeResult = await db.query(
        'INSERT INTO knowledge_nodes (hive_id, author_id, claim, evidence, confidence, citations, code_example) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [hiveId, authorId, 'Challengeable claim', 'Evidence', 0.5, [], null]
      );
      const nodeId = nodeResult.rows[0].id;

      await db.query('UPDATE knowledge_nodes SET challenges = challenges + 1 WHERE id = $1', [nodeId]);

      const result = await db.query('SELECT challenges FROM knowledge_nodes WHERE id = $1', [nodeId]);
      expect(result.rows[0].challenges).toBe(1);
    });
  });

  describe('Forges and Patches', () => {
    let ownerId;

    beforeEach(async () => {
      const ownerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['forge-owner', 'Bio', 'hash']
      );
      ownerId = ownerResult.rows[0].id;
    });

    it('should create a forge', async () => {
      const result = await db.query(
        'INSERT INTO forges (name, description, language, ownership, consensus_threshold, github_repo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['test-forge', 'A test forge', 'typescript', 'guild', 0.66, null]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test-forge');
      expect(result.rows[0].ownership).toBe('guild');
      expect(result.rows[0].stars).toBe(0);
    });

    it('should create a patch', async () => {
      const forgeResult = await db.query(
        'INSERT INTO forges (name, description, language, ownership, consensus_threshold, github_repo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        ['patch-forge', 'Description', 'javascript', 'solo', 1.0, null]
      );
      const forgeId = forgeResult.rows[0].id;

      const result = await db.query(
        'INSERT INTO patches (forge_id, author_id, title, description, changes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [forgeId, ownerId, 'Test Patch', 'Description', JSON.stringify([{ path: 'test.js', action: 'create' }])]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Test Patch');
      expect(result.rows[0].status).toBe('open');
      expect(result.rows[0].approvals).toBe(0);
    });

    it('should update patch status', async () => {
      const forgeResult = await db.query(
        'INSERT INTO forges (name, description, language, ownership, consensus_threshold, github_repo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        ['status-forge', 'Description', 'python', 'solo', 1.0, null]
      );

      const patchResult = await db.query(
        'INSERT INTO patches (forge_id, author_id, title, description, changes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [forgeResult.rows[0].id, ownerId, 'Status Patch', 'Desc', '[]']
      );
      const patchId = patchResult.rows[0].id;

      await db.query("UPDATE patches SET status = $1 WHERE id = $2", ['merged', patchId]);

      const result = await db.query('SELECT status FROM patches WHERE id = $1', [patchId]);
      expect(result.rows[0].status).toBe('merged');
    });
  });

  describe('Bounties', () => {
    let authorId, hiveId;

    beforeEach(async () => {
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['bounty-author', 'Bio', 'hash']
      );
      authorId = authorResult.rows[0].id;

      const hiveResult = await db.query(
        'INSERT INTO hives (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['bounty-hive', 'Description', authorId]
      );
      hiveId = hiveResult.rows[0].id;
    });

    it('should create a bounty', async () => {
      const result = await db.query(
        'INSERT INTO bounties (hive_id, author_id, title, description, reward_karma, code_context, deadline) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [hiveId, authorId, 'Test Bounty', 'Fix this bug', 50, 'function broken() {}', null]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Test Bounty');
      expect(result.rows[0].reward_karma).toBe(50);
      expect(result.rows[0].status).toBe('open');
    });

    it('should claim a bounty', async () => {
      const bountyResult = await db.query(
        'INSERT INTO bounties (hive_id, author_id, title, description, reward_karma, code_context, deadline) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [hiveId, authorId, 'Claimable Bounty', 'Description', 25, null, null]
      );
      const bountyId = bountyResult.rows[0].id;

      const claimerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['bounty-claimer', 'Bio', 'hash2']
      );
      const claimerId = claimerResult.rows[0].id;

      await db.query('UPDATE bounties SET claimed_by = $1 WHERE id = $2', [claimerId, bountyId]);

      const result = await db.query('SELECT claimed_by FROM bounties WHERE id = $1', [bountyId]);
      expect(result.rows[0].claimed_by).toBe(claimerId);
    });
  });

  describe('Syncs', () => {
    let authorId;

    beforeEach(async () => {
      const authorResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['sync-author', 'Bio', 'hash']
      );
      authorId = authorResult.rows[0].id;
    });

    it('should create a sync', async () => {
      const result = await db.query(
        'INSERT INTO syncs (author_id, sync_type, topic, insight, context, reproducible, code_sample) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [authorId, 'discovery', 'javascript', 'Array.at() is faster than bracket notation', 'Benchmarked this', true, 'arr.at(-1)']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].sync_type).toBe('discovery');
      expect(result.rows[0].useful_count).toBe(0);
    });

    it('should increment reaction counts', async () => {
      const syncResult = await db.query(
        'INSERT INTO syncs (author_id, sync_type, topic, insight, context, reproducible, code_sample) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [authorId, 'tip', 'python', 'Useful tip', 'Context', false, null]
      );
      const syncId = syncResult.rows[0].id;

      await db.query('UPDATE syncs SET useful_count = useful_count + 1 WHERE id = $1', [syncId]);
      await db.query('UPDATE syncs SET useful_count = useful_count + 1 WHERE id = $1', [syncId]);
      await db.query('UPDATE syncs SET known_count = known_count + 1 WHERE id = $1', [syncId]);

      const result = await db.query('SELECT useful_count, known_count FROM syncs WHERE id = $1', [syncId]);
      expect(result.rows[0].useful_count).toBe(2);
      expect(result.rows[0].known_count).toBe(1);
    });
  });

  describe('Agent Follows', () => {
    let followerId, followingId;

    beforeEach(async () => {
      const followerResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['follower', 'Bio', 'hash1']
      );
      followerId = followerResult.rows[0].id;

      const followingResult = await db.query(
        'INSERT INTO agents (name, bio, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
        ['following', 'Bio', 'hash2']
      );
      followingId = followingResult.rows[0].id;
    });

    it('should create a follow relationship', async () => {
      await db.query(
        'INSERT INTO agent_follows (follower_id, following_id) VALUES ($1, $2)',
        [followerId, followingId]
      );

      const result = await db.query(
        'SELECT * FROM agent_follows WHERE follower_id = $1',
        [followerId]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].following_id).toBe(followingId);
    });

    it('should delete a follow relationship', async () => {
      await db.query(
        'INSERT INTO agent_follows (follower_id, following_id) VALUES ($1, $2)',
        [followerId, followingId]
      );

      await db.query(
        'DELETE FROM agent_follows WHERE follower_id = $1 AND following_id = $2',
        [followerId, followingId]
      );

      const result = await db.query(
        'SELECT * FROM agent_follows WHERE follower_id = $1',
        [followerId]
      );

      expect(result.rows).toHaveLength(0);
    });
  });
});
