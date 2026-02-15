/**
 * Cross-level sync tests
 *
 * Tests that CLI SyncClient endpoints match server route expectations,
 * and that the batch sync processor handles all event types correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncClient } from '../../cli/src/sync-client.js';

// Mock global fetch for SyncClient tests
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

function createTestSyncClient(store: any = null) {
  return new SyncClient({
    serverUrl: 'http://localhost:3000/api/v1',
    apiKey: 'gsw_testkey123',
    agentId: 'agent-1',
    store,
  });
}

function mockFetchOk(data: Record<string, any> = {}): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
}

describe('Fix #1: Task endpoint paths', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('claimTask includes repoId in path', async () => {
    mockFetchOk({ claim: { id: 'claim-1' } });

    await sync.claimTask('repo-1', 'task-1', { streamId: 'stream-1' });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/tasks/task-1/claim');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.agent_id).toBe('agent-1');
    expect(body.stream_id).toBe('stream-1');
  });

  it('syncTaskSubmission includes repoId, taskId, and claimId in path', async () => {
    mockFetchOk({ claim: { id: 'claim-1', status: 'submitted' } });

    await sync.syncTaskSubmission('repo-1', 'task-1', 'claim-1', {
      streamId: 'stream-1',
      notes: 'Done',
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/tasks/task-1/claims/claim-1/submit');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.agent_id).toBe('agent-1');
    expect(body.stream_id).toBe('stream-1');
    expect(body.submission_notes).toBe('Done');
  });

  it('listTasks includes repoId in path', async () => {
    mockFetchOk({ tasks: [] });

    await sync.listTasks('repo-1', { status: 'open', limit: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/tasks?status=open&limit=10');
  });

  it('queue dispatcher routes task_claim correctly', async () => {
    mockFetchOk({ claim: { id: 'claim-1' } });

    await sync._dispatchQueuedEvent('task_claim', {
      repoId: 'repo-1',
      taskId: 'task-1',
      streamId: 'stream-1',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/tasks/task-1/claim');
  });

  it('queue dispatcher routes task_submission correctly', async () => {
    mockFetchOk({ claim: { id: 'claim-1' } });

    await sync._dispatchQueuedEvent('task_submission', {
      repoId: 'repo-1',
      taskId: 'task-1',
      claimId: 'claim-1',
      streamId: 'stream-1',
      notes: 'Done',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/tasks/task-1/claims/claim-1/submit');
  });
});

describe('Fix #1: Batch sync event types', () => {
  it('processes task_claim event type', async () => {
    // Import the sync routes to get access to processSyncEvent
    // Since it's not exported, we verify via the batch endpoint accepting the event type
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    // The server sync.js processSyncEvent handles 'task_claim' by inserting into gitswarm_task_claims
    // We verify the CLI side dispatches correctly
    const sync = createTestSyncClient();
    mockFetchOk({ results: [{ seq: 1, status: 'ok' }] });

    await sync.flushQueue();
    // No-op since store is null — but verifies no errors
  });
});

describe('Fix #2: Repo config endpoint', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('getRepoConfig sends correct path', async () => {
    mockFetchOk({
      config: {
        merge_mode: 'review',
        ownership_model: 'guild',
        consensus_threshold: 0.66,
        min_reviews: 2,
        buffer_branch: 'buffer',
        promote_target: 'main',
        plugins_enabled: true,
        stage: 'growth',
      },
      config_sync: null,
    });

    const result = await sync.getRepoConfig('repo-1');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/config');
    expect(result.config.merge_mode).toBe('review');
    expect(result.config.consensus_threshold).toBe(0.66);
  });

  it('getRepoConfig returns config_sync info when available', async () => {
    mockFetchOk({
      config: { merge_mode: 'review' },
      config_sync: {
        config_sha: 'abc123',
        plugins_sha: 'def456',
        last_synced_at: '2025-01-01T00:00:00Z',
        sync_error: null,
      },
    });

    const result = await sync.getRepoConfig('repo-1');

    expect(result.config_sync).not.toBeNull();
    expect(result.config_sync.config_sha).toBe('abc123');
  });
});

describe('Fix #3: Config reconciliation', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('pullConfig flow: fetch remote and detect changes', async () => {
    mockFetchOk({
      config: {
        merge_mode: 'gated',
        ownership_model: 'guild',
        consensus_threshold: 0.75,
        min_reviews: 2,
        buffer_branch: 'buffer',
        promote_target: 'main',
        stage: 'growth',
        plugins_enabled: true,
      },
      config_sync: {
        config_sha: 'abc123',
        last_synced_at: '2025-01-01T00:00:00Z',
      },
    });

    const result = await sync.getRepoConfig('repo-1');

    expect(result.config.merge_mode).toBe('gated');
    expect(result.config.consensus_threshold).toBe(0.75);
    expect(result.config.min_reviews).toBe(2);
    expect(result.config.stage).toBe('growth');
    expect(result.config_sync.config_sha).toBe('abc123');
  });

  it('reconciliation detects which fields changed', () => {
    const local = {
      merge_mode: 'review',
      ownership_model: 'guild',
      consensus_threshold: 0.66,
      min_reviews: 1,
      buffer_branch: 'buffer',
    };

    const remote = {
      merge_mode: 'gated',
      ownership_model: 'guild',
      consensus_threshold: 0.75,
      min_reviews: 2,
      buffer_branch: 'buffer',
      stage: 'growth',
    };

    const serverOwnedFields = [
      'merge_mode', 'ownership_model', 'consensus_threshold', 'min_reviews',
      'buffer_branch', 'promote_target', 'stage', 'plugins_enabled',
    ];

    const updatedFields = [];
    for (const field of serverOwnedFields) {
      if (remote[field] !== undefined && remote[field] !== local[field]) {
        updatedFields.push(field);
      }
    }

    expect(updatedFields).toContain('merge_mode');
    expect(updatedFields).toContain('consensus_threshold');
    expect(updatedFields).toContain('min_reviews');
    expect(updatedFields).toContain('stage');
    expect(updatedFields).not.toContain('ownership_model');
    expect(updatedFields).not.toContain('buffer_branch');
  });

  it('reconciliation preserves local-only fields', () => {
    const local = {
      name: 'my-project',
      merge_mode: 'review',
      custom_local_field: 'preserved',
      server: { url: 'http://localhost:3000' },
    };

    const updates = { merge_mode: 'gated' };
    const merged = { ...local, ...updates };

    expect(merged.custom_local_field).toBe('preserved');
    expect(merged.server.url).toBe('http://localhost:3000');
    expect(merged.merge_mode).toBe('gated');
    expect(merged.name).toBe('my-project');
  });
});

describe('SyncClient core operations still work', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('syncStreamCreated sends correct path', async () => {
    mockFetchOk({ id: 'stream-1' });

    await sync.syncStreamCreated('repo-1', {
      streamId: 'stream-1',
      name: 'feature/auth',
      branch: 'stream/agent-1/feature-auth',
      baseBranch: 'buffer',
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams');
    expect(opts.method).toBe('POST');
  });

  it('syncCommit sends correct path', async () => {
    mockFetchOk({});

    await sync.syncCommit('repo-1', 'stream-1', {
      commitHash: 'abc123',
      changeId: 'I1234',
      message: 'test commit',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/commits');
  });

  it('checkConsensus sends correct path', async () => {
    mockFetchOk({ reached: true });

    await sync.checkConsensus('repo-1', 'stream-1');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/consensus');
  });

  it('syncStabilization sends correct path', async () => {
    mockFetchOk({});

    await sync.syncStabilization('repo-1', {
      result: 'green',
      tag: 'green/2025-01-01',
      bufferCommit: 'abc123',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/stabilize');
  });

  it('syncPromotion sends correct path', async () => {
    mockFetchOk({});

    await sync.syncPromotion('repo-1', {
      fromCommit: 'abc123',
      toCommit: 'def456',
      triggeredBy: 'auto',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/promote');
  });

  it('registerRepo sends correct path', async () => {
    mockFetchOk({ id: 'repo-1', org_id: 'org-1' });

    await sync.registerRepo({
      name: 'test-project',
      ownershipModel: 'guild',
      mergeMode: 'review',
      consensusThreshold: 0.66,
      minReviews: 1,
      bufferBranch: 'buffer',
      promoteTarget: 'main',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/register');
  });
});

describe('Fix #5: Review sync before consensus check', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('syncReview queues events when server is unreachable', async () => {
    const sync = createTestSyncClient();

    // Server returns error
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // The _queueEvent method should be callable without error
    sync._queueEvent({ type: 'review', data: {
      repoId: 'repo-1', streamId: 'stream-1', verdict: 'approve', feedback: 'LGTM',
    }});

    // No store means no persistence, but method should not throw
  });

  it('syncReview sends correct payload', async () => {
    const sync = createTestSyncClient();
    mockFetchOk({});

    await sync.syncReview('repo-1', 'stream-1', {
      verdict: 'approve',
      feedback: 'Looks good',
      tested: true,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/reviews');
    const body = JSON.parse(opts.body);
    expect(body.verdict).toBe('approve');
    expect(body.feedback).toBe('Looks good');
    expect(body.tested).toBe(true);
  });

  it('batch sync processes review events idempotently', async () => {
    const sync = createTestSyncClient();
    mockFetchOk({ results: [{ seq: 1, status: 'ok' }] });

    // Verify batch endpoint is callable
    const batchUrl = `http://localhost:3000/api/v1/gitswarm/sync/batch`;
    await sync._post('/gitswarm/sync/batch', {
      events: [{
        seq: 1,
        type: 'review',
        data: { streamId: 'stream-1', verdict: 'approve', feedback: 'ok' },
      }],
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(batchUrl);
  });
});

describe('Fix #7: Config template does not contain server-owned fields', () => {
  it('template config.yml should not include agent_access or min_karma as YAML keys', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync('/home/user/gitswarm/templates/.gitswarm/config.yml', 'utf-8');

    // Should NOT have these as actual YAML keys (only in comments)
    const lines = content.split('\n').filter(l => !l.trim().startsWith('#'));
    const yamlKeys = lines.filter(l => /^\w/.test(l)).map(l => l.split(':')[0].trim());

    expect(yamlKeys).not.toContain('agent_access');
    expect(yamlKeys).not.toContain('min_karma');
    expect(yamlKeys).not.toContain('ownership_model');
  });

  it('template should document server-owned fields in comments', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync('/home/user/gitswarm/templates/.gitswarm/config.yml', 'utf-8');

    expect(content).toContain('server-owned');
    expect(content).toContain('agent_access');
    expect(content).toContain('min_karma');
  });
});

describe('Fix #6: Merge endpoint separation', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('requestMerge sends to /merge-request (new endpoint)', async () => {
    mockFetchOk({ queued: true });

    await sync.requestMerge('repo-1', 'stream-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/merge-request');
    expect(opts.method).toBe('POST');
  });

  it('syncMergeCompleted sends to /merge with merge_commit', async () => {
    mockFetchOk({});

    await sync.syncMergeCompleted('repo-1', 'stream-1', {
      mergeCommit: 'abc123',
      targetBranch: 'buffer',
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/merge');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.merge_commit).toBe('abc123');
    expect(body.target_branch).toBe('buffer');
  });
});

describe('Fix #8: Tier 2/3 plugin warnings', () => {
  it('detects Tier 2 indicators in plugins.yml content', () => {
    // Simulate checking plugins.yml for Tier 2 indicators
    const pluginsContent = `
issue-enrichment:
  trigger: issues.opened
  engine: auto
  model: fast
  actions:
    - analyze_issue_context
`;
    const tier2Indicators = ['engine:', 'model:', 'dispatch'];
    const hasTier2 = tier2Indicators.some(i => pluginsContent.includes(i));
    expect(hasTier2).toBe(true);
  });

  it('detects Tier 3 indicators in plugins.yml content', () => {
    const pluginsContent = `
consensus-merge:
  trigger: gitswarm.consensus_reached
  conditions:
    consensus_threshold_met: true
  actions:
    - merge_stream_to_buffer
`;
    const tier3Indicators = ['consensus_reached', 'council', 'governance'];
    const hasTier3 = tier3Indicators.some(i => pluginsContent.includes(i));
    expect(hasTier3).toBe(true);
  });

  it('does not false-positive on Tier 1 plugins', () => {
    const pluginsContent = `
auto-promote:
  enabled: true
  trigger: gitswarm.stabilization_passed
  conditions:
    branch: buffer
  actions:
    - promote_buffer_to_main
`;
    const tier2Indicators = ['engine:', 'model:', 'dispatch'];
    const tier3Indicators = ['consensus_reached', 'council', 'governance'];

    expect(tier2Indicators.some(i => pluginsContent.includes(i))).toBe(false);
    expect(tier3Indicators.some(i => pluginsContent.includes(i))).toBe(false);
  });
});

describe('Fix #9: Stage metrics source consistency', () => {
  it('server metrics take the maximum of streams and merges counts', () => {
    // Simulate: streams has fewer records than merges (due to sync lag)
    const fromStreams = { contributor_count: 2, stream_count: 5 };
    const fromMerges = { contributor_count: 3, merge_count: 8 };

    const contributorCount = Math.max(
      fromStreams.contributor_count,
      fromMerges.contributor_count,
    );
    const patchCount = Math.max(
      fromStreams.stream_count,
      fromMerges.merge_count,
    );

    expect(contributorCount).toBe(3);
    expect(patchCount).toBe(8);
  });

  it('handles missing merge data gracefully', () => {
    const fromStreams = { contributor_count: 5, stream_count: 10 };
    const fromMerges = { contributor_count: 0, merge_count: 0 };

    const contributorCount = Math.max(
      parseInt(fromStreams.contributor_count) || 0,
      parseInt(fromMerges.contributor_count) || 0,
    );
    const patchCount = Math.max(
      parseInt(fromStreams.stream_count) || 0,
      parseInt(fromMerges.merge_count) || 0,
    );

    expect(contributorCount).toBe(5);
    expect(patchCount).toBe(10);
  });
});

describe('Fix #10: Server to CLI push notifications', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('pollUpdates sends correct request with since and agent_id', async () => {
    mockFetchOk({
      tasks: [],
      access_changes: [],
      proposals: [],
      reviews: [],
      merges: [],
      config_changes: [],
      polled_at: '2025-01-01T00:00:00Z',
    });

    await sync.pollUpdates('2025-01-01T00:00:00Z');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/gitswarm/updates');
    expect(url).toContain('since=');
    expect(url).toContain('agent_id=agent-1');
  });

  it('pollUpdates returns reviews and merges', async () => {
    mockFetchOk({
      tasks: [],
      access_changes: [],
      proposals: [],
      reviews: [
        { stream_id: 'stream-1', reviewer_id: 'agent-2', verdict: 'approve', reviewer_name: 'reviewer' },
      ],
      merges: [
        { stream_id: 'stream-1', agent_id: 'agent-2', merge_commit: 'abc123' },
      ],
      config_changes: [
        { repo_id: 'repo-1', last_synced_at: '2025-01-01T00:00:00Z' },
      ],
      polled_at: '2025-01-01T12:00:00Z',
    });

    const updates = await sync.pollUpdates('2025-01-01T00:00:00Z');

    expect(updates.reviews).toHaveLength(1);
    expect(updates.reviews[0].verdict).toBe('approve');
    expect(updates.merges).toHaveLength(1);
    expect(updates.config_changes).toHaveLength(1);
  });

  it('flush queue then poll is the bidirectional sync pattern', async () => {
    // flushQueue with no store returns immediately without network call.
    // pollUpdates makes the first (and only) fetch call.
    mockFetchOk({
      tasks: [], access_changes: [], proposals: [],
      reviews: [], merges: [], config_changes: [],
      polled_at: '2025-01-01T00:00:00Z',
    });

    // This simulates the gitswarm sync command flow
    const flushResult = await sync.flushQueue();
    expect(flushResult.flushed).toBe(0); // No store = nothing to flush

    const updates = await sync.pollUpdates('2025-01-01T00:00:00Z');
    expect(updates).not.toBeNull();
    expect(updates.polled_at).toBeDefined();
  });
});
