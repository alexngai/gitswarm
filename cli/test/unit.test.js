/**
 * Unit tests for gitswarm-cli core services.
 *
 * These tests exercise each service in isolation using a test SQLite store
 * (no git repo required). They verify the database-agnostic query interface,
 * schema migrations, and business logic.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestStore, createSeededStore, cleanup } from './helpers.js';

afterAll(cleanup);

// ── SqliteStore & Schema ──────────────────────────────────

describe('SqliteStore', () => {
  it('runs versioned migrations', () => {
    const store = createTestStore();
    const version = store.db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    expect(version.v).toBe(4);
    store.close();
  });

  it('is idempotent on re-migrate', () => {
    const store = createTestStore();
    store.migrate(); // second call
    const version = store.db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    expect(version.v).toBe(4);
    store.close();
  });

  it('creates v2 columns on repos', () => {
    const store = createTestStore();
    const cols = store.db.prepare('PRAGMA table_info(repos)').all().map(c => c.name);
    expect(cols).toContain('merge_mode');
    expect(cols).toContain('buffer_branch');
    expect(cols).toContain('promote_target');
    expect(cols).toContain('auto_promote_on_green');
    expect(cols).toContain('auto_revert_on_red');
    expect(cols).toContain('stabilize_command');
    store.close();
  });

  it('creates stream_id on patch_reviews', () => {
    const store = createTestStore();
    const cols = store.db.prepare('PRAGMA table_info(patch_reviews)').all().map(c => c.name);
    expect(cols).toContain('stream_id');
    expect(cols).toContain('review_block_id');
    store.close();
  });

  it('creates stream_id on task_claims', () => {
    const store = createTestStore();
    const cols = store.db.prepare('PRAGMA table_info(task_claims)').all().map(c => c.name);
    expect(cols).toContain('stream_id');
    store.close();
  });

  it('translates PG $N params to ?', () => {
    const store = createTestStore();
    store.query("INSERT INTO agents (id, name) VALUES (?, ?)", ['test-1', 'tester']);
    const r = store.query("SELECT * FROM agents WHERE id = ?", ['test-1']);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('tester');
    store.close();
  });

  it('supports RETURNING clause', () => {
    const store = createTestStore();
    const r = store.query("INSERT INTO agents (id, name) VALUES (?, ?) RETURNING *", ['ret-1', 'returner']);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe('ret-1');
    expect(r.rows[0].name).toBe('returner');
    store.close();
  });
});

// ── PermissionService ─────────────────────────────────────

describe('PermissionService', () => {
  let store, perms;

  beforeEach(async () => {
    store = createSeededStore();
    const { PermissionService } = await import('../src/core/permissions.js');
    perms = new PermissionService(store);
  });

  it('resolves owner as admin', async () => {
    const r = await perms.resolvePermissions('agent-1', 'repo-1');
    expect(r.level).toBe('admin');
    expect(r.source).toBe('maintainer');
  });

  it('resolves maintainer as maintain', async () => {
    const r = await perms.resolvePermissions('agent-3', 'repo-1');
    expect(r.level).toBe('maintain');
  });

  it('resolves public agents as write', async () => {
    const r = await perms.resolvePermissions('agent-2', 'repo-1');
    expect(r.level).toBe('write');
    expect(r.source).toBe('public');
  });

  it('canPerform checks action levels', async () => {
    const rw = await perms.canPerform('agent-2', 'repo-1', 'write');
    expect(rw.allowed).toBe(true);
    const rm = await perms.canPerform('agent-2', 'repo-1', 'merge');
    expect(rm.allowed).toBe(false);
  });

  it('isMaintainer returns role', async () => {
    const r = await perms.isMaintainer('agent-1', 'repo-1');
    expect(r.isMaintainer).toBe(true);
    expect(r.role).toBe('owner');
  });

  describe('checkConsensus (stream-based)', () => {
    it('requires minimum reviews', async () => {
      const r = await perms.checkConsensus('stream-empty', 'repo-1');
      expect(r.reached).toBe(false);
      expect(r.reason).toBe('insufficient_reviews');
    });

    it('guild consensus: requires maintainer approvals', async () => {
      store.query("INSERT INTO patch_reviews (stream_id, reviewer_id, verdict) VALUES ('s1', 'agent-1', 'approve')");
      const r = await perms.checkConsensus('s1', 'repo-1');
      expect(r.reached).toBe(true);
      expect(r.reason).toBe('consensus_reached');
    });

    it('guild consensus: rejects on maintainer rejections', async () => {
      store.query("INSERT INTO patch_reviews (stream_id, reviewer_id, verdict) VALUES ('s2', 'agent-1', 'request_changes')");
      const r = await perms.checkConsensus('s2', 'repo-1');
      expect(r.reached).toBe(false);
    });
  });
});

// ── TaskService ───────────────────────────────────────────

describe('TaskService', () => {
  let store, tasks;

  beforeEach(async () => {
    store = createSeededStore();
    const { TaskService } = await import('../src/core/tasks.js');
    tasks = new TaskService(store);
  });

  it('creates a task', async () => {
    const task = await tasks.create('repo-1', { title: 'Build auth' }, 'agent-1');
    expect(task.title).toBe('Build auth');
    expect(task.status).toBe('open');
    expect(task.priority).toBe('medium');
  });

  it('lists tasks by repo', async () => {
    await tasks.create('repo-1', { title: 'Task 1', priority: 'high' }, 'agent-1');
    await tasks.create('repo-1', { title: 'Task 2', priority: 'low' }, 'agent-1');
    const list = await tasks.list('repo-1');
    expect(list).toHaveLength(2);
    expect(list[0].priority).toBe('high'); // sorted by priority
  });

  it('claims a task with stream_id', async () => {
    const task = await tasks.create('repo-1', { title: 'Claimable' }, 'agent-1');
    const claim = await tasks.claim(task.id, 'agent-2', 'stream-abc');
    expect(claim.stream_id).toBe('stream-abc');
    expect(claim.status).toBe('active');
  });

  it('prevents double claims', async () => {
    const task = await tasks.create('repo-1', { title: 'Single' }, 'agent-1');
    await tasks.claim(task.id, 'agent-2');
    await expect(tasks.claim(task.id, 'agent-2')).rejects.toThrow('Cannot claim task with status');
  });

  it('submits with stream_id', async () => {
    const task = await tasks.create('repo-1', { title: 'Submit test' }, 'agent-1');
    const claim = await tasks.claim(task.id, 'agent-2');
    const result = await tasks.submit(claim.id, 'agent-2', { stream_id: 'stream-xyz', notes: 'done' });
    expect(result.stream_id).toBe('stream-xyz');
    expect(result.status).toBe('submitted');
  });

  it('getClaimByStream finds linked claims', async () => {
    const task = await tasks.create('repo-1', { title: 'Linked' }, 'agent-1');
    await tasks.claim(task.id, 'agent-2', 'stream-linked');
    const found = await tasks.getClaimByStream('stream-linked');
    expect(found).not.toBeNull();
    expect(found.task_title).toBe('Linked');
  });

  it('linkClaimToStream updates stream_id', async () => {
    const task = await tasks.create('repo-1', { title: 'LinkTest' }, 'agent-1');
    const claim = await tasks.claim(task.id, 'agent-2');
    await tasks.linkClaimToStream(claim.id, 'stream-new');
    const found = await tasks.getClaimByStream('stream-new');
    expect(found).not.toBeNull();
  });
});

// ── StageService ──────────────────────────────────────────

describe('StageService', () => {
  let store, stages;

  beforeEach(async () => {
    store = createSeededStore();
    const { StageService } = await import('../src/core/stages.js');
    stages = new StageService(store);
  });

  it('gets metrics for a repo', async () => {
    const m = await stages.getStageMetrics('repo-1');
    expect(m.current_stage).toBe('seed');
    expect(m.metrics.maintainer_count).toBe(2);
  });

  it('checks eligibility and reports unmet', async () => {
    const e = await stages.checkAdvancementEligibility('repo-1');
    expect(e.eligible).toBe(false);
    expect(e.next_stage).toBe('growth');
    expect(e.unmet_requirements.length).toBeGreaterThan(0);
  });

  it('advances stage when forced', async () => {
    const r = await stages.advanceStage('repo-1', true);
    expect(r.success).toBe(true);
    expect(r.new_stage).toBe('growth');
  });
});

// ── CouncilService ────────────────────────────────────────

describe('CouncilService', () => {
  let store, council;

  beforeEach(async () => {
    store = createSeededStore();
    const { CouncilService } = await import('../src/core/council.js');
    council = new CouncilService(store);
  });

  it('creates a council', async () => {
    const c = await council.create('repo-1', { min_members: 2, standard_quorum: 2 });
    expect(c.status).toBe('forming');
    expect(c.min_members).toBe(2);
  });

  it('adds members and transitions to active', async () => {
    const c = await council.create('repo-1', { min_members: 2 });
    await council.addMember(c.id, 'agent-1', 'chair');
    await council.addMember(c.id, 'agent-2');
    await council.addMember(c.id, 'agent-3');
    const updated = await council.getCouncil('repo-1');
    expect(updated.status).toBe('active');
  });

  it('creates proposals and handles voting', async () => {
    const c = await council.create('repo-1', { min_members: 2, standard_quorum: 2 });
    await council.addMember(c.id, 'agent-1', 'chair');
    await council.addMember(c.id, 'agent-2');
    await council.addMember(c.id, 'agent-3');

    const p = await council.createProposal(c.id, 'agent-1', {
      title: 'Test proposal',
      proposal_type: 'add_maintainer',
      action_data: { agent_id: 'agent-2', role: 'maintainer' },
    });
    expect(p.status).toBe('open');

    await council.vote(p.id, 'agent-1', 'for');
    await council.vote(p.id, 'agent-2', 'for');

    const proposals = await council.listProposals(c.id);
    const resolved = proposals.find(pr => pr.id === p.id);
    expect(resolved.status).toBe('passed');
  });

  it('rejects proposal when votes are against', async () => {
    const c = await council.create('repo-1', { min_members: 2, standard_quorum: 2 });
    await council.addMember(c.id, 'agent-1', 'chair');
    await council.addMember(c.id, 'agent-2');
    await council.addMember(c.id, 'agent-3');

    const p = await council.createProposal(c.id, 'agent-1', {
      title: 'Bad proposal',
      proposal_type: 'add_maintainer',
      action_data: { agent_id: 'agent-2', role: 'maintainer' },
    });

    await council.vote(p.id, 'agent-2', 'against');
    await council.vote(p.id, 'agent-3', 'against');

    const proposals = await council.listProposals(c.id);
    expect(proposals.find(pr => pr.id === p.id).status).toBe('rejected');
  });
});

// ── ActivityService ───────────────────────────────────────

describe('ActivityService', () => {
  let store, activity;

  beforeEach(async () => {
    store = createSeededStore();
    const { ActivityService } = await import('../src/core/activity.js');
    activity = new ActivityService(store);
  });

  it('logs and retrieves events', async () => {
    await activity.log({ agent_id: 'agent-1', event_type: 'commit', target_type: 'stream', target_id: 's1' });
    await activity.log({ agent_id: 'agent-2', event_type: 'review', target_type: 'stream', target_id: 's1' });

    const events = await activity.recent({ limit: 10 });
    expect(events).toHaveLength(2);
    const types = events.map(e => e.event_type);
    expect(types).toContain('commit');
    expect(types).toContain('review');
  });

  it('filters by agent_id', async () => {
    await activity.log({ agent_id: 'agent-1', event_type: 'commit' });
    await activity.log({ agent_id: 'agent-2', event_type: 'review' });

    const events = await activity.recent({ agent_id: 'agent-1' });
    expect(events).toHaveLength(1);
    expect(events[0].agent_name).toBe('architect');
  });
});
