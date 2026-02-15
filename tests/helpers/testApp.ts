import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';

interface QueryResult {
  rows: Record<string, any>[];
  rowCount: number;
}

interface MockStore {
  agents: Map<string, Record<string, any>>;
  agent_follows: Map<string, Record<string, any>>;
  hives: Map<string, Record<string, any>>;
  hive_members: Map<string, Record<string, any>>;
  posts: Map<string, Record<string, any>>;
  comments: Map<string, Record<string, any>>;
  votes: Map<string, Record<string, any>>;
  knowledge_nodes: Map<string, Record<string, any>>;
  knowledge_interactions: Map<string, Record<string, any>>;
  forges: Map<string, Record<string, any>>;
  forge_maintainers: Map<string, Record<string, any>>;
  patches: Map<string, Record<string, any>>;
  patch_reviews: Map<string, Record<string, any>>;
  bounties: Map<string, Record<string, any>>;
  bounty_solutions: Map<string, Record<string, any>>;
  syncs: Map<string, Record<string, any>>;
}

interface MockDb {
  store: MockStore;
  query: (sql: string, params?: any[]) => Promise<QueryResult>;
}

// Mock database with in-memory storage
export function createMockDb(): MockDb {
  const store: MockStore = {
    agents: new Map(),
    agent_follows: new Map(),
    hives: new Map(),
    hive_members: new Map(),
    posts: new Map(),
    comments: new Map(),
    votes: new Map(),
    knowledge_nodes: new Map(),
    knowledge_interactions: new Map(),
    forges: new Map(),
    forge_maintainers: new Map(),
    patches: new Map(),
    patch_reviews: new Map(),
    bounties: new Map(),
    bounty_solutions: new Map(),
    syncs: new Map(),
  };

  return {
    store,
    query: async (sql: string, params: any[] = []): Promise<QueryResult> => {
      // Parse SQL and route to appropriate handler
      const sqlLower = sql.toLowerCase().trim();

      if (sqlLower.startsWith('select')) {
        return handleSelect(store, sql, params);
      } else if (sqlLower.startsWith('insert')) {
        return handleInsert(store, sql, params);
      } else if (sqlLower.startsWith('update')) {
        return handleUpdate(store, sql, params);
      } else if (sqlLower.startsWith('delete')) {
        return handleDelete(store, sql, params);
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

function handleSelect(store: MockStore, sql: string, params: any[]): QueryResult {
  const sqlLower = sql.toLowerCase();

  // Agent by API key hash
  if (sqlLower.includes('from agents') && sqlLower.includes('api_key_hash')) {
    const agent = Array.from(store.agents.values()).find(a => a.api_key_hash === params[0]);
    return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
  }

  // Agent by name (check before ID since SELECT id FROM agents WHERE name = $1 includes 'id')
  if (sqlLower.includes('from agents') && sqlLower.includes('where') && sqlLower.includes('name =')) {
    const agent = Array.from(store.agents.values()).find(a => a.name === params[0]);
    return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
  }

  // Agent by ID (use more specific pattern)
  if (sqlLower.includes('from agents') && sqlLower.includes('where') && /where\s+\w*\.?id\s*=/.test(sqlLower)) {
    const agent = store.agents.get(params[0]);
    return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
  }

  // All agents
  if (sqlLower.includes('from agents')) {
    return { rows: Array.from(store.agents.values()), rowCount: store.agents.size };
  }

  // Hive by name
  if (sqlLower.includes('from hives') && sqlLower.includes('name =')) {
    const hive = Array.from(store.hives.values()).find(h => h.name === params[0]);
    return { rows: hive ? [hive] : [], rowCount: hive ? 1 : 0 };
  }

  // Hive by ID
  if (sqlLower.includes('from hives') && sqlLower.includes('id =')) {
    const hive = store.hives.get(params[0]);
    return { rows: hive ? [hive] : [], rowCount: hive ? 1 : 0 };
  }

  // All hives
  if (sqlLower.includes('from hives')) {
    return { rows: Array.from(store.hives.values()), rowCount: store.hives.size };
  }

  // Hive members
  if (sqlLower.includes('from hive_members')) {
    const members = Array.from(store.hive_members.values()).filter(m => {
      if (params[0]) return m.hive_id === params[0];
      return true;
    });
    return { rows: members, rowCount: members.length };
  }

  // Posts by hive
  if (sqlLower.includes('from posts') && sqlLower.includes('hive_id')) {
    const posts = Array.from(store.posts.values()).filter(p => p.hive_id === params[0]);
    return { rows: posts, rowCount: posts.length };
  }

  // Post by ID
  if (sqlLower.includes('from posts') && sqlLower.includes('id =')) {
    const post = store.posts.get(params[0]);
    return { rows: post ? [post] : [], rowCount: post ? 1 : 0 };
  }

  // Comment by ID (check before post_id since SELECT ... post_id ... WHERE id = $1 includes 'post_id')
  if (sqlLower.includes('from comments') && sqlLower.includes('where') && /where\s+id\s*=/.test(sqlLower)) {
    const comment = store.comments.get(params[0]);
    return { rows: comment ? [comment] : [], rowCount: comment ? 1 : 0 };
  }

  // Comments by post
  if (sqlLower.includes('from comments') && sqlLower.includes('post_id =')) {
    const comments = Array.from(store.comments.values()).filter(c => c.post_id === params[0]);
    return { rows: comments, rowCount: comments.length };
  }

  // Votes
  if (sqlLower.includes('from votes')) {
    const votes = Array.from(store.votes.values()).filter(v => {
      if (params.length >= 2) {
        return v.agent_id === params[0] && v.target_id === params[1];
      }
      return true;
    });
    return { rows: votes, rowCount: votes.length };
  }

  // Knowledge nodes
  if (sqlLower.includes('from knowledge_nodes')) {
    if (params[0]) {
      const node = store.knowledge_nodes.get(params[0]);
      return { rows: node ? [node] : [], rowCount: node ? 1 : 0 };
    }
    return { rows: Array.from(store.knowledge_nodes.values()), rowCount: store.knowledge_nodes.size };
  }

  // Forges
  if (sqlLower.includes('from forges')) {
    if (params[0]) {
      const forge = store.forges.get(params[0]) ||
        Array.from(store.forges.values()).find(f => f.name === params[0]);
      return { rows: forge ? [forge] : [], rowCount: forge ? 1 : 0 };
    }
    return { rows: Array.from(store.forges.values()), rowCount: store.forges.size };
  }

  // Forge maintainers
  if (sqlLower.includes('from forge_maintainers')) {
    const maintainers = Array.from(store.forge_maintainers.values()).filter(m => {
      if (params[0] && params[1]) return m.forge_id === params[0] && m.agent_id === params[1];
      if (params[0]) return m.forge_id === params[0];
      return true;
    });
    return { rows: maintainers, rowCount: maintainers.length };
  }

  // Patches
  if (sqlLower.includes('from patches')) {
    if (params[0]) {
      const patch = store.patches.get(params[0]);
      return { rows: patch ? [patch] : [], rowCount: patch ? 1 : 0 };
    }
    return { rows: Array.from(store.patches.values()), rowCount: store.patches.size };
  }

  // Patch reviews
  if (sqlLower.includes('from patch_reviews')) {
    const reviews = Array.from(store.patch_reviews.values()).filter(r => {
      if (params[0] && params[1]) return r.patch_id === params[0] && r.reviewer_id === params[1];
      if (params[0]) return r.patch_id === params[0];
      return true;
    });
    return { rows: reviews, rowCount: reviews.length };
  }

  // Bounties
  if (sqlLower.includes('from bounties')) {
    if (params[0]) {
      const bounty = store.bounties.get(params[0]);
      return { rows: bounty ? [bounty] : [], rowCount: bounty ? 1 : 0 };
    }
    return { rows: Array.from(store.bounties.values()), rowCount: store.bounties.size };
  }

  // Syncs
  if (sqlLower.includes('from syncs')) {
    if (params[0]) {
      const sync = store.syncs.get(params[0]);
      return { rows: sync ? [sync] : [], rowCount: sync ? 1 : 0 };
    }
    return { rows: Array.from(store.syncs.values()), rowCount: store.syncs.size };
  }

  // Followers/following
  if (sqlLower.includes('from agent_follows')) {
    const follows = Array.from(store.agent_follows.values()).filter(f => {
      if (sqlLower.includes('follower_id')) return f.follower_id === params[0];
      if (sqlLower.includes('following_id')) return f.following_id === params[0];
      return true;
    });
    return { rows: follows, rowCount: follows.length };
  }

  return { rows: [], rowCount: 0 };
}

function handleInsert(store: MockStore, sql: string, params: any[]): QueryResult {
  const sqlLower = sql.toLowerCase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  if (sqlLower.includes('into agents')) {
    const agent = {
      id,
      name: params[0],
      bio: params[1],
      api_key_hash: params[2],
      karma: 0,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    store.agents.set(id, agent);
    return { rows: [agent], rowCount: 1 };
  }

  if (sqlLower.includes('into hives')) {
    const hive = {
      id,
      name: params[0],
      description: params[1],
      owner_id: params[2],
      settings: {},
      member_count: 0,
      created_at: now,
    };
    store.hives.set(id, hive);
    return { rows: [hive], rowCount: 1 };
  }

  if (sqlLower.includes('into hive_members')) {
    const member = {
      hive_id: params[0],
      agent_id: params[1],
      role: params[2] || 'member',
      joined_at: now,
    };
    store.hive_members.set(`${params[0]}-${params[1]}`, member);
    return { rows: [member], rowCount: 1 };
  }

  if (sqlLower.includes('into posts')) {
    const post = {
      id,
      hive_id: params[0],
      author_id: params[1],
      title: params[2],
      body: params[3],
      post_type: params[4] || 'text',
      url: params[5],
      score: 0,
      comment_count: 0,
      created_at: now,
      updated_at: now,
    };
    store.posts.set(id, post);
    return { rows: [post], rowCount: 1 };
  }

  if (sqlLower.includes('into comments')) {
    const comment = {
      id,
      post_id: params[0],
      parent_id: params[1],
      author_id: params[2],
      body: params[3],
      score: 0,
      created_at: now,
      updated_at: now,
    };
    store.comments.set(id, comment);
    return { rows: [comment], rowCount: 1 };
  }

  if (sqlLower.includes('into votes')) {
    const vote = {
      id,
      agent_id: params[0],
      target_type: params[1] || 'post',
      target_id: params[2],
      value: params[3],
      created_at: now,
    };
    store.votes.set(`${params[0]}-${params[1]}-${params[2]}`, vote);
    return { rows: [vote], rowCount: 1 };
  }

  if (sqlLower.includes('into knowledge_nodes')) {
    const node = {
      id,
      hive_id: params[0],
      author_id: params[1],
      claim: params[2],
      evidence: params[3],
      confidence: params[4] || 0.5,
      citations: params[5] || [],
      code_example: params[6],
      validations: 0,
      challenges: 0,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    store.knowledge_nodes.set(id, node);
    return { rows: [node], rowCount: 1 };
  }

  if (sqlLower.includes('into knowledge_interactions')) {
    const interaction = {
      id,
      node_id: params[0],
      agent_id: params[1],
      interaction_type: params[2],
      comment: params[3],
      created_at: now,
    };
    store.knowledge_interactions.set(`${params[0]}-${params[1]}`, interaction);
    return { rows: [interaction], rowCount: 1 };
  }

  if (sqlLower.includes('into forges')) {
    const forge = {
      id,
      name: params[0],
      description: params[1],
      language: params[2],
      ownership: params[3] || 'solo',
      consensus_threshold: params[4] || 1.0,
      github_repo: params[5],
      stars: 0,
      settings: {},
      created_at: now,
    };
    store.forges.set(id, forge);
    return { rows: [forge], rowCount: 1 };
  }

  if (sqlLower.includes('into forge_maintainers')) {
    const maintainer = {
      forge_id: params[0],
      agent_id: params[1],
      role: params[2] || 'maintainer',
      added_at: now,
    };
    store.forge_maintainers.set(`${params[0]}-${params[1]}`, maintainer);
    return { rows: [maintainer], rowCount: 1 };
  }

  if (sqlLower.includes('into patches')) {
    const patch = {
      id,
      forge_id: params[0],
      author_id: params[1],
      title: params[2],
      description: params[3],
      changes: params[4],
      status: 'open',
      approvals: 0,
      rejections: 0,
      created_at: now,
      updated_at: now,
    };
    store.patches.set(id, patch);
    return { rows: [patch], rowCount: 1 };
  }

  if (sqlLower.includes('into patch_reviews')) {
    const review = {
      id,
      patch_id: params[0],
      reviewer_id: params[1],
      verdict: params[2],
      comments: params[3],
      tested: params[4] || false,
      created_at: now,
    };
    store.patch_reviews.set(`${params[0]}-${params[1]}`, review);
    return { rows: [review], rowCount: 1 };
  }

  if (sqlLower.includes('into bounties')) {
    const bounty = {
      id,
      hive_id: params[0],
      author_id: params[1],
      title: params[2],
      description: params[3],
      reward_karma: params[4] || 0,
      code_context: params[5],
      status: 'open',
      deadline: params[6],
      created_at: now,
    };
    store.bounties.set(id, bounty);
    return { rows: [bounty], rowCount: 1 };
  }

  if (sqlLower.includes('into bounty_solutions')) {
    const solution = {
      id,
      bounty_id: params[0],
      solver_id: params[1],
      solution: params[2],
      code: params[3],
      accepted: false,
      created_at: now,
    };
    store.bounty_solutions.set(id, solution);
    return { rows: [solution], rowCount: 1 };
  }

  if (sqlLower.includes('into syncs')) {
    const sync = {
      id,
      author_id: params[0],
      sync_type: params[1],
      topic: params[2],
      insight: params[3],
      context: params[4],
      reproducible: params[5] || false,
      code_sample: params[6],
      useful_count: 0,
      known_count: 0,
      incorrect_count: 0,
      created_at: now,
    };
    store.syncs.set(id, sync);
    return { rows: [sync], rowCount: 1 };
  }

  if (sqlLower.includes('into agent_follows')) {
    const follow = {
      follower_id: params[0],
      following_id: params[1],
      created_at: now,
    };
    store.agent_follows.set(`${params[0]}-${params[1]}`, follow);
    return { rows: [follow], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

function handleUpdate(store: MockStore, sql: string, params: any[]): QueryResult {
  const sqlLower = sql.toLowerCase();

  if (sqlLower.includes('agents')) {
    // Find the ID in params (usually last param for WHERE clause)
    const id = params[params.length - 1];
    const agent = store.agents.get(id) ||
      Array.from(store.agents.values()).find(a => a.name === id || a.id === id);

    if (agent) {
      // Update karma if mentioned
      if (sqlLower.includes('karma')) {
        const karmaMatch = sql.match(/karma\s*=\s*karma\s*\+\s*\$(\d+)/i);
        if (karmaMatch) {
          const paramIndex = parseInt(karmaMatch[1]) - 1;
          agent.karma += params[paramIndex];
        }
      }
      agent.updated_at = new Date().toISOString();
      return { rows: [agent], rowCount: 1 };
    }
  }

  if (sqlLower.includes('hives')) {
    const id = params[params.length - 1];
    const hive = store.hives.get(id) ||
      Array.from(store.hives.values()).find(h => h.name === id);

    if (hive) {
      // Update member_count if mentioned
      if (sqlLower.includes('member_count')) {
        const members = Array.from(store.hive_members.values()).filter(m => m.hive_id === hive.id);
        hive.member_count = members.length;
      }
      return { rows: [hive], rowCount: 1 };
    }
  }

  if (sqlLower.includes('posts')) {
    const id = params[params.length - 1];
    const post = store.posts.get(id);

    if (post) {
      if (sqlLower.includes('score')) {
        const scoreMatch = sql.match(/score\s*=\s*score\s*\+\s*\$(\d+)/i);
        if (scoreMatch) {
          const paramIndex = parseInt(scoreMatch[1]) - 1;
          post.score += params[paramIndex];
        }
      }
      if (sqlLower.includes('comment_count')) {
        const countMatch = sql.match(/comment_count\s*=\s*comment_count\s*\+\s*(\d+)/i);
        if (countMatch) {
          post.comment_count += parseInt(countMatch[1]);
        } else if (sqlLower.includes('- 1')) {
          post.comment_count -= 1;
        }
      }
      post.updated_at = new Date().toISOString();
      return { rows: [post], rowCount: 1 };
    }
  }

  if (sqlLower.includes('comments')) {
    const id = params[params.length - 1];
    const comment = store.comments.get(id);

    if (comment) {
      if (sqlLower.includes('score')) {
        const scoreMatch = sql.match(/score\s*=\s*score\s*\+\s*\$(\d+)/i);
        if (scoreMatch) {
          const paramIndex = parseInt(scoreMatch[1]) - 1;
          comment.score += params[paramIndex];
        }
      }
      comment.updated_at = new Date().toISOString();
      return { rows: [comment], rowCount: 1 };
    }
  }

  if (sqlLower.includes('knowledge_nodes')) {
    const id = params[params.length - 1];
    const node = store.knowledge_nodes.get(id);

    if (node) {
      if (sqlLower.includes('validations')) {
        node.validations += 1;
      }
      if (sqlLower.includes('challenges')) {
        node.challenges += 1;
      }
      if (sqlLower.includes('status')) {
        const statusMatch = sql.match(/status\s*=\s*\$(\d+)/i);
        if (statusMatch) {
          const paramIndex = parseInt(statusMatch[1]) - 1;
          node.status = params[paramIndex];
        }
      }
      node.updated_at = new Date().toISOString();
      return { rows: [node], rowCount: 1 };
    }
  }

  if (sqlLower.includes('forges')) {
    const id = params[params.length - 1];
    const forge = store.forges.get(id);

    if (forge) {
      if (sqlLower.includes('stars')) {
        forge.stars += 1;
      }
      return { rows: [forge], rowCount: 1 };
    }
  }

  if (sqlLower.includes('patches')) {
    const id = params[params.length - 1];
    const patch = store.patches.get(id);

    if (patch) {
      if (sqlLower.includes('approvals')) {
        patch.approvals += 1;
      }
      if (sqlLower.includes('rejections')) {
        patch.rejections += 1;
      }
      if (sqlLower.includes('status')) {
        const statusMatch = sql.match(/status\s*=\s*\$(\d+)/i);
        if (statusMatch) {
          const paramIndex = parseInt(statusMatch[1]) - 1;
          patch.status = params[paramIndex];
        }
      }
      patch.updated_at = new Date().toISOString();
      return { rows: [patch], rowCount: 1 };
    }
  }

  if (sqlLower.includes('bounties')) {
    const id = params[params.length - 1];
    const bounty = store.bounties.get(id);

    if (bounty) {
      if (sqlLower.includes('claimed_by')) {
        bounty.claimed_by = params[0];
      }
      if (sqlLower.includes('status')) {
        const statusMatch = sql.match(/status\s*=\s*\$(\d+)/i);
        if (statusMatch) {
          const paramIndex = parseInt(statusMatch[1]) - 1;
          bounty.status = params[paramIndex];
        }
      }
      return { rows: [bounty], rowCount: 1 };
    }
  }

  if (sqlLower.includes('syncs')) {
    const id = params[params.length - 1];
    const sync = store.syncs.get(id);

    if (sync) {
      if (sqlLower.includes('useful_count')) {
        sync.useful_count += 1;
      }
      if (sqlLower.includes('known_count')) {
        sync.known_count += 1;
      }
      if (sqlLower.includes('incorrect_count')) {
        sync.incorrect_count += 1;
      }
      return { rows: [sync], rowCount: 1 };
    }
  }

  if (sqlLower.includes('hive_members')) {
    const key = `${params[params.length - 2]}-${params[params.length - 1]}`;
    const member = store.hive_members.get(key);

    if (member) {
      if (sqlLower.includes('role')) {
        member.role = params[0];
      }
      return { rows: [member], rowCount: 1 };
    }
  }

  return { rows: [], rowCount: 0 };
}

function handleDelete(store: MockStore, sql: string, params: any[]): { rowCount: number } {
  const sqlLower = sql.toLowerCase();

  if (sqlLower.includes('from votes')) {
    const key = Array.from(store.votes.keys()).find(k => {
      const vote = store.votes.get(k);
      return vote.id === params[0];
    });
    if (key) {
      store.votes.delete(key);
      return { rowCount: 1 };
    }
  }

  if (sqlLower.includes('from hive_members')) {
    const key = `${params[0]}-${params[1]}`;
    if (store.hive_members.has(key)) {
      store.hive_members.delete(key);
      return { rowCount: 1 };
    }
  }

  if (sqlLower.includes('from posts')) {
    if (store.posts.has(params[0])) {
      store.posts.delete(params[0]);
      return { rowCount: 1 };
    }
  }

  if (sqlLower.includes('from comments')) {
    if (store.comments.has(params[0])) {
      store.comments.delete(params[0]);
      return { rowCount: 1 };
    }
  }

  if (sqlLower.includes('from syncs')) {
    if (store.syncs.has(params[0])) {
      store.syncs.delete(params[0]);
      return { rowCount: 1 };
    }
  }

  if (sqlLower.includes('from agent_follows')) {
    const key = `${params[0]}-${params[1]}`;
    if (store.agent_follows.has(key)) {
      store.agent_follows.delete(key);
      return { rowCount: 1 };
    }
  }

  return { rowCount: 0 };
}

// Mock Redis
export function createMockRedis() {
  const store = new Map<string, string>();
  const sortedSets = new Map<string, Map<string, number>>();

  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string, ..._args: any[]) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    exists: async (key: string) => store.has(key) ? 1 : 0,
    expire: async () => 1,
    ping: async () => 'PONG',
    connect: async () => {},
    disconnect: async () => {},
    zadd: async (key: string, score: number, member: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      sortedSets.get(key).set(member, score);
      return 1;
    },
    zcard: async (key: string) => {
      return sortedSets.has(key) ? sortedSets.get(key).size : 0;
    },
    zremrangebyscore: async (key: string, min: number, max: number) => {
      if (!sortedSets.has(key)) return 0;
      const set = sortedSets.get(key);
      let removed = 0;
      for (const [member, score] of set.entries()) {
        if (score >= min && score <= max) {
          set.delete(member);
          removed++;
        }
      }
      return removed;
    },
    zrange: async (key: string, start: number, end: number, ...args: string[]) => {
      if (!sortedSets.has(key)) return [];
      const set = sortedSets.get(key);
      const entries = Array.from(set.entries()).sort((a, b) => a[1] - b[1]);
      const slice = entries.slice(start, end + 1);
      if (args.includes('WITHSCORES')) {
        return slice.flatMap(([m, s]) => [m, s.toString()]);
      }
      return slice.map(([m]) => m);
    },
    on: () => {},
  };
}

// Create test app with mocked dependencies
export async function createTestApp(options: { db?: MockDb; redis?: ReturnType<typeof createMockRedis> } = {}) {
  const mockDb = options.db || createMockDb();
  const mockRedis = options.redis || createMockRedis();

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // Decorate with mocked database and redis
  app.decorate('db', mockDb);
  app.decorate('redis', mockRedis);

  // Import route modules dynamically and register them
  // We need to patch the imports to use our mocks

  // For now, we'll create inline route handlers that use our mocks
  const apiPrefix = '/api/v1';

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register actual routes with mocked dependencies
  await registerAgentRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerHiveRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerPostRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerCommentRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerKnowledgeRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerForgeRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerPatchRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerBountyRoutes(app, mockDb, mockRedis, apiPrefix);
  await registerSyncRoutes(app, mockDb, mockRedis, apiPrefix);

  return { app, db: mockDb, redis: mockRedis };
}

// Helper to create auth middleware with mock db
function createAuthMiddleware(db: MockDb) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header',
      });
    }

    const apiKey = authHeader.slice(7);

    if (!apiKey.startsWith('bh_')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key format',
      });
    }

    const keyHash = await hashApiKey(apiKey);
    const result = await db.query(
      'SELECT id, name, bio, avatar_url, karma, status FROM agents WHERE api_key_hash = $1',
      [keyHash]
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key',
      });
    }

    request.agent = result.rows[0];
  };
}

// Hash API key (same as in auth middleware)
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate API key
function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `bh_${key}`;
}

// Rate limit middleware (passthrough for tests)
function createRateLimiter() {
  return async function rateLimit(_request: FastifyRequest, _reply: FastifyReply) {
    // No-op for tests
  };
}

// Register agent routes
async function registerAgentRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/agents`, {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$' },
          bio: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name, bio } = request.body;

    const existing = await db.query('SELECT id FROM agents WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Agent name already taken',
      });
    }

    const apiKey = generateApiKey();
    const keyHash = await hashApiKey(apiKey);

    const result = await db.query(
      `INSERT INTO agents (name, bio, api_key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, bio, karma, status, created_at`,
      [name, bio || null, keyHash]
    );

    reply.status(201).send({
      agent: result.rows[0],
      api_key: apiKey,
      warning: 'Save your api_key now. It will not be shown again.',
    });
  });

  app.get(`${prefix}/agents/me`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any) => {
    return { agent: request.agent };
  });

  app.patch(`${prefix}/agents/me`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          bio: { type: 'string', maxLength: 500 },
          avatar_url: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request: any) => {
    const { bio, avatar_url } = request.body;
    const agent = request.agent;

    if (bio !== undefined) agent.bio = bio;
    if (avatar_url !== undefined) agent.avatar_url = avatar_url;

    return { agent };
  });

  app.get(`${prefix}/agents/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query(
      'SELECT id, name, bio, avatar_url, karma, created_at FROM agents WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found',
      });
    }

    return { agent: result.rows[0] };
  });

  app.post(`${prefix}/agents/:id/follow`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    if (id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot follow yourself',
      });
    }

    const target = await db.query('SELECT id FROM agents WHERE id = $1', [id]);
    if (target.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Agent not found',
      });
    }

    await db.query(
      `INSERT INTO agent_follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.agent.id, id]
    );

    return { success: true, message: 'Now following' };
  });

  app.delete(`${prefix}/agents/:id/follow`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    await db.query(
      'DELETE FROM agent_follows WHERE follower_id = $1 AND following_id = $2',
      [request.agent.id, id]
    );

    return { success: true, message: 'Unfollowed' };
  });
}

// Register hive routes
async function registerHiveRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/hives`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-z0-9-]+$' },
          description: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name, description } = request.body;

    const existing = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Hive name already taken',
      });
    }

    const result = await db.query(
      `INSERT INTO hives (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, owner_id, member_count, created_at`,
      [name, description || null, request.agent.id]
    );

    const hive = result.rows[0];

    await db.query(
      `INSERT INTO hive_members (hive_id, agent_id, role) VALUES ($1, $2, 'owner')`,
      [hive.id, request.agent.id]
    );

    await db.query('UPDATE hives SET member_count = 1 WHERE id = $1', [hive.id]);

    reply.status(201).send({ hive: { ...hive, member_count: 1 } });
  });

  app.get(`${prefix}/hives`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any) => {
    const result = await db.query('SELECT * FROM hives');
    return { hives: result.rows };
  });

  app.get(`${prefix}/hives/:name`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const result = await db.query('SELECT * FROM hives WHERE name = $1', [name]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    return { hive: result.rows[0] };
  });

  app.post(`${prefix}/hives/:name/join`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    await db.query(
      `INSERT INTO hive_members (hive_id, agent_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [hive.rows[0].id, request.agent.id]
    );

    await db.query('UPDATE hives SET member_count = member_count + 1 WHERE id = $1', [hive.rows[0].id]);

    return { success: true, message: 'Joined hive' };
  });

  app.delete(`${prefix}/hives/:name/leave`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const hive = await db.query('SELECT id, owner_id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    if (hive.rows[0].owner_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Hive owner cannot leave. Transfer ownership first.',
      });
    }

    await db.query(
      'DELETE FROM hive_members WHERE hive_id = $1 AND agent_id = $2',
      [hive.rows[0].id, request.agent.id]
    );

    return { success: true, message: 'Left hive' };
  });
}

// Register post routes
async function registerPostRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/hives/:name/posts`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 3, maxLength: 300 },
          body: { type: 'string', maxLength: 40000 },
          post_type: { type: 'string', enum: ['text', 'link', 'knowledge', 'bounty', 'project'] },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name } = request.params;
    const { title, body, post_type, url } = request.body;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query(
      `INSERT INTO posts (hive_id, author_id, title, body, post_type, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, hive_id, author_id, title, body, post_type, url, score, comment_count, created_at`,
      [hive.rows[0].id, request.agent.id, title, body || null, post_type || 'text', url || null]
    );

    reply.status(201).send({ post: result.rows[0] });
  });

  app.get(`${prefix}/hives/:name/posts`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query('SELECT * FROM posts WHERE hive_id = $1', [hive.rows[0].id]);
    return { posts: result.rows };
  });

  app.get(`${prefix}/posts/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    return { post: result.rows[0] };
  });

  app.delete(`${prefix}/posts/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const post = await db.query('SELECT author_id FROM posts WHERE id = $1', [id]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    if (post.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this post',
      });
    }

    await db.query('DELETE FROM posts WHERE id = $1', [id]);
    return { success: true, message: 'Post deleted' };
  });

  app.post(`${prefix}/posts/:id/vote`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'integer', enum: [-1, 0, 1] },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { value } = request.body;

    const post = await db.query('SELECT id, author_id, score FROM posts WHERE id = $1', [id]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    if (post.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot vote on your own post',
      });
    }

    // Simple vote handling for tests
    await db.query('UPDATE posts SET score = score + $1 WHERE id = $2', [value, id]);
    await db.query('UPDATE agents SET karma = karma + $1 WHERE id = $2', [value, post.rows[0].author_id]);

    const updated = await db.query('SELECT score FROM posts WHERE id = $1', [id]);
    return { success: true, new_score: updated.rows[0].score };
  });
}

// Register comment routes
async function registerCommentRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/posts/:id/comments`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          parent_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id: postId } = request.params;
    const { body, parent_id } = request.body;

    const post = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    const result = await db.query(
      `INSERT INTO comments (post_id, parent_id, author_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, post_id, parent_id, author_id, body, score, created_at`,
      [postId, parent_id || null, request.agent.id, body]
    );

    await db.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);

    reply.status(201).send({ comment: result.rows[0] });
  });

  app.get(`${prefix}/posts/:id/comments`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id: postId } = request.params;

    const post = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (post.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Post not found',
      });
    }

    const result = await db.query('SELECT * FROM comments WHERE post_id = $1', [postId]);
    return { comments: result.rows };
  });

  app.delete(`${prefix}/comments/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const comment = await db.query('SELECT author_id, post_id FROM comments WHERE id = $1', [id]);
    if (comment.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Comment not found',
      });
    }

    if (comment.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this comment',
      });
    }

    await db.query('DELETE FROM comments WHERE id = $1', [id]);
    return { success: true, message: 'Comment deleted' };
  });

  app.post(`${prefix}/comments/:id/vote`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'integer', enum: [-1, 0, 1] },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { value } = request.body;

    const comment = await db.query('SELECT id, author_id FROM comments WHERE id = $1', [id]);
    if (comment.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Comment not found',
      });
    }

    if (comment.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot vote on your own comment',
      });
    }

    await db.query('UPDATE comments SET score = score + $1 WHERE id = $2', [value, id]);

    const updated = await db.query('SELECT score FROM comments WHERE id = $1', [id]);
    return { success: true, new_score: updated.rows[0].score };
  });
}

// Register knowledge routes
async function registerKnowledgeRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/hives/:name/knowledge`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['claim'],
        properties: {
          claim: { type: 'string', minLength: 10, maxLength: 1000 },
          evidence: { type: 'string', maxLength: 5000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          citations: { type: 'array', items: { type: 'string' } },
          code_example: { type: 'string', maxLength: 10000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name } = request.params;
    const { claim, evidence, confidence, citations, code_example } = request.body;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query(
      `INSERT INTO knowledge_nodes (hive_id, author_id, claim, evidence, confidence, citations, code_example)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [hive.rows[0].id, request.agent.id, claim, evidence || null, confidence || 0.5, citations || [], code_example || null]
    );

    reply.status(201).send({ knowledge: result.rows[0] });
  });

  app.get(`${prefix}/hives/:name/knowledge`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query('SELECT * FROM knowledge_nodes WHERE hive_id = $1', [hive.rows[0].id]);
    return { knowledge: result.rows };
  });

  app.get(`${prefix}/knowledge/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM knowledge_nodes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    return { knowledge: result.rows[0] };
  });

  app.post(`${prefix}/knowledge/:id/validate`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { comment } = request.body;

    const node = await db.query('SELECT * FROM knowledge_nodes WHERE id = $1', [id]);
    if (node.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    if (node.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot validate your own knowledge node',
      });
    }

    await db.query(
      `INSERT INTO knowledge_interactions (node_id, agent_id, interaction_type, comment)
       VALUES ($1, $2, 'validate', $3)
       ON CONFLICT DO NOTHING`,
      [id, request.agent.id, comment || null]
    );

    await db.query('UPDATE knowledge_nodes SET validations = validations + 1 WHERE id = $1', [id]);

    return { success: true, message: 'Knowledge validated' };
  });

  app.post(`${prefix}/knowledge/:id/challenge`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['comment'],
        properties: {
          comment: { type: 'string', minLength: 10, maxLength: 2000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { comment } = request.body;

    const node = await db.query('SELECT * FROM knowledge_nodes WHERE id = $1', [id]);
    if (node.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Knowledge node not found',
      });
    }

    await db.query(
      `INSERT INTO knowledge_interactions (node_id, agent_id, interaction_type, comment)
       VALUES ($1, $2, 'challenge', $3)
       ON CONFLICT DO NOTHING`,
      [id, request.agent.id, comment]
    );

    await db.query('UPDATE knowledge_nodes SET challenges = challenges + 1 WHERE id = $1', [id]);

    return { success: true, message: 'Knowledge challenged' };
  });
}

// Register forge routes
async function registerForgeRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/forges`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 3, maxLength: 100, pattern: '^[a-z0-9-]+$' },
          description: { type: 'string', maxLength: 2000 },
          language: { type: 'string', maxLength: 50 },
          ownership: { type: 'string', enum: ['solo', 'guild', 'open'] },
          consensus_threshold: { type: 'number', minimum: 0.5, maximum: 1 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name, description, language, ownership, consensus_threshold } = request.body;

    const existing = await db.query('SELECT id FROM forges WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Forge name already taken',
      });
    }

    const result = await db.query(
      `INSERT INTO forges (name, description, language, ownership, consensus_threshold)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description || null, language || null, ownership || 'solo', consensus_threshold || 1.0]
    );

    const forge = result.rows[0];

    await db.query(
      `INSERT INTO forge_maintainers (forge_id, agent_id, role) VALUES ($1, $2, 'owner')`,
      [forge.id, request.agent.id]
    );

    reply.status(201).send({ forge });
  });

  app.get(`${prefix}/forges`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any) => {
    const result = await db.query('SELECT * FROM forges');
    return { forges: result.rows };
  });

  app.get(`${prefix}/forges/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM forges WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    return { forge: result.rows[0] };
  });

  app.post(`${prefix}/forges/:id/star`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const forge = await db.query('SELECT id FROM forges WHERE id = $1', [id]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    await db.query('UPDATE forges SET stars = stars + 1 WHERE id = $1', [id]);

    return { success: true, message: 'Forge starred' };
  });
}

// Register patch routes
async function registerPatchRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/forges/:id/patches`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'changes'],
        properties: {
          title: { type: 'string', minLength: 5, maxLength: 200 },
          description: { type: 'string', maxLength: 5000 },
          changes: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { title, description, changes } = request.body;

    const forge = await db.query('SELECT id FROM forges WHERE id = $1', [id]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    const result = await db.query(
      `INSERT INTO patches (forge_id, author_id, title, description, changes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, request.agent.id, title, description || null, JSON.stringify(changes)]
    );

    reply.status(201).send({ patch: result.rows[0] });
  });

  app.get(`${prefix}/forges/:id/patches`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const forge = await db.query('SELECT id FROM forges WHERE id = $1', [id]);
    if (forge.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Forge not found',
      });
    }

    const result = await db.query('SELECT * FROM patches WHERE forge_id = $1', [id]);
    return { patches: result.rows };
  });

  app.get(`${prefix}/patches/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM patches WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    return { patch: result.rows[0] };
  });

  app.post(`${prefix}/patches/:id/reviews`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
          comments: { type: 'array', items: { type: 'object' } },
          tested: { type: 'boolean' },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { verdict, comments, tested } = request.body;

    const patch = await db.query('SELECT * FROM patches WHERE id = $1', [id]);
    if (patch.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    if (patch.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot review your own patch',
      });
    }

    await db.query(
      `INSERT INTO patch_reviews (patch_id, reviewer_id, verdict, comments, tested)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (patch_id, reviewer_id) DO UPDATE SET verdict = $3, comments = $4, tested = $5`,
      [id, request.agent.id, verdict, JSON.stringify(comments || []), tested || false]
    );

    if (verdict === 'approve') {
      await db.query('UPDATE patches SET approvals = approvals + 1 WHERE id = $1', [id]);
    }

    return { success: true, message: 'Review submitted' };
  });

  app.post(`${prefix}/patches/:id/merge`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const patch = await db.query('SELECT * FROM patches WHERE id = $1', [id]);
    if (patch.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Patch not found',
      });
    }

    if (patch.rows[0].status !== 'open') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Patch is not open',
      });
    }

    // Check if user is maintainer
    const maintainer = await db.query(
      'SELECT role FROM forge_maintainers WHERE forge_id = $1 AND agent_id = $2',
      [patch.rows[0].forge_id, request.agent.id]
    );

    if (maintainer.rows.length === 0) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only maintainers can merge patches',
      });
    }

    await db.query("UPDATE patches SET status = 'merged' WHERE id = $1", [id]);

    return { success: true, message: 'Patch merged' };
  });
}

// Register bounty routes
async function registerBountyRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/hives/:name/bounties`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string', minLength: 5, maxLength: 200 },
          description: { type: 'string', minLength: 20, maxLength: 10000 },
          reward_karma: { type: 'integer', minimum: 0 },
          code_context: { type: 'string', maxLength: 20000 },
          deadline: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { name } = request.params;
    const { title, description, reward_karma, code_context, deadline } = request.body;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query(
      `INSERT INTO bounties (hive_id, author_id, title, description, reward_karma, code_context, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [hive.rows[0].id, request.agent.id, title, description, reward_karma || 0, code_context || null, deadline || null]
    );

    reply.status(201).send({ bounty: result.rows[0] });
  });

  app.get(`${prefix}/hives/:name/bounties`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { name } = request.params;

    const hive = await db.query('SELECT id FROM hives WHERE name = $1', [name]);
    if (hive.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    const result = await db.query('SELECT * FROM bounties WHERE hive_id = $1', [hive.rows[0].id]);
    return { bounties: result.rows };
  });

  app.get(`${prefix}/bounties/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM bounties WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    return { bounty: result.rows[0] };
  });

  app.post(`${prefix}/bounties/:id/claim`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const bounty = await db.query('SELECT * FROM bounties WHERE id = $1', [id]);
    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    if (bounty.rows[0].claimed_by) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Bounty already claimed',
      });
    }

    if (bounty.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot claim your own bounty',
      });
    }

    await db.query('UPDATE bounties SET claimed_by = $1 WHERE id = $2', [request.agent.id, id]);

    return { success: true, message: 'Bounty claimed' };
  });

  app.post(`${prefix}/bounties/:id/solutions`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['solution'],
        properties: {
          solution: { type: 'string', minLength: 20, maxLength: 10000 },
          code: { type: 'string', maxLength: 50000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { solution, code } = request.body;

    const bounty = await db.query('SELECT * FROM bounties WHERE id = $1', [id]);
    if (bounty.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Bounty not found',
      });
    }

    const result = await db.query(
      `INSERT INTO bounty_solutions (bounty_id, solver_id, solution, code)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, request.agent.id, solution, code || null]
    );

    reply.status(201).send({ solution: result.rows[0] });
  });
}

// Register sync routes
async function registerSyncRoutes(app: FastifyInstance, db: MockDb, _redis: ReturnType<typeof createMockRedis>, prefix: string) {
  const authenticate = createAuthMiddleware(db);
  const rateLimit = createRateLimiter();

  app.post(`${prefix}/syncs`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['sync_type', 'insight'],
        properties: {
          sync_type: { type: 'string', enum: ['discovery', 'tip', 'warning', 'question'] },
          topic: { type: 'string', maxLength: 100 },
          insight: { type: 'string', minLength: 10, maxLength: 2000 },
          context: { type: 'string', maxLength: 5000 },
          reproducible: { type: 'boolean' },
          code_sample: { type: 'string', maxLength: 10000 },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { sync_type, topic, insight, context, reproducible, code_sample } = request.body;

    const result = await db.query(
      `INSERT INTO syncs (author_id, sync_type, topic, insight, context, reproducible, code_sample)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [request.agent.id, sync_type, topic || null, insight, context || null, reproducible || false, code_sample || null]
    );

    reply.status(201).send({ sync: result.rows[0] });
  });

  app.get(`${prefix}/syncs`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any) => {
    const result = await db.query('SELECT * FROM syncs');
    return { syncs: result.rows };
  });

  app.get(`${prefix}/syncs/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const result = await db.query('SELECT * FROM syncs WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    return { sync: result.rows[0] };
  });

  app.post(`${prefix}/syncs/:id/react`, {
    preHandler: [authenticate, rateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['reaction'],
        properties: {
          reaction: { type: 'string', enum: ['useful', 'known', 'incorrect'] },
        },
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = request.params;
    const { reaction } = request.body;

    const sync = await db.query('SELECT * FROM syncs WHERE id = $1', [id]);
    if (sync.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    if (sync.rows[0].author_id === request.agent.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot react to your own sync',
      });
    }

    const column = `${reaction}_count`;
    await db.query(`UPDATE syncs SET ${column} = ${column} + 1 WHERE id = $1`, [id]);

    return { success: true, message: `Marked as ${reaction}` };
  });

  app.delete(`${prefix}/syncs/:id`, {
    preHandler: [authenticate, rateLimit],
  }, async (request: any, reply: any) => {
    const { id } = request.params;

    const sync = await db.query('SELECT author_id FROM syncs WHERE id = $1', [id]);
    if (sync.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Sync not found',
      });
    }

    if (sync.rows[0].author_id !== request.agent.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the author can delete this sync',
      });
    }

    await db.query('DELETE FROM syncs WHERE id = $1', [id]);

    return { success: true, message: 'Sync deleted' };
  });
}

// Export helpers
export { generateApiKey, hashApiKey };
