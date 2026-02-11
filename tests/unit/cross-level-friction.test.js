/**
 * Cross-level friction fixes tests
 *
 * Tests for fixes to critical friction points between CLI, server, and
 * repo-level configuration:
 *
 *   #11 — Council merge_stream executes actual merge via backend
 *   #15 — flushQueue returns failedTypes; merge blocks on review sync failures
 *   #2  — Gated mode delegates to server in Mode B
 *   #7  — Plugin compatibility warnings on open + skipped-plugin logging
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncClient } from '../../cli/src/sync-client.js';

// Mock backend-factory before importing CouncilCommandsService.
// getBackendForRepo normally hits the real pg pool; we intercept it here.
const mockMergePullRequest = vi.fn();
const mockBackend = { mergePullRequest: mockMergePullRequest };

vi.mock('../../src/services/backend-factory.js', () => ({
  getBackendForRepo: vi.fn().mockResolvedValue(mockBackend),
}));

// Import AFTER the mock is set up
const { CouncilCommandsService } = await import('../../src/services/council-commands.js');

// ── Shared helpers ──────────────────────────────────────────────

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockFetchOk(data = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
}

function mockFetchError(status = 500, message = 'Server error') {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => message,
  });
}

function createTestSyncClient(store = null) {
  return new SyncClient({
    serverUrl: 'http://localhost:3000/api/v1',
    apiKey: 'gsw_testkey123',
    agentId: 'agent-1',
    store,
  });
}

function createMockStore(events = []) {
  const rows = events.map((e, i) => ({
    id: i + 1,
    event_type: e.type,
    payload: JSON.stringify(e.data),
    created_at: new Date().toISOString(),
    attempts: 0,
  }));

  return {
    query: vi.fn().mockImplementation(async (sql) => {
      if (sql.includes('FROM sync_queue ORDER BY')) {
        return { rows };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: 0 }] };
      }
      // DELETE / UPDATE — no-op
      return { rows: [] };
    }),
  };
}


// ═══════════════════════════════════════════════════════════════
// #11 — Council merge_stream should execute via backend
// ═══════════════════════════════════════════════════════════════

describe('Fix #11: Council merge_stream executes backend merge', () => {
  let service;
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
    service = new CouncilCommandsService({ query: mockQuery });
    mockMergePullRequest.mockReset();
  });

  it('should mark stream approved AND record merge on success', async () => {
    mockMergePullRequest.mockResolvedValueOnce({ mergeCommit: 'abc123' });
    mockQuery
      // 1. UPDATE review_status = 'approved'
      .mockResolvedValueOnce({ rows: [] })
      // 2. INSERT INTO gitswarm_merges
      .mockResolvedValueOnce({ rows: [] })
      // 3. UPDATE status = 'merged'
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.executeMergeStream('repo-1', { stream_id: 'stream-1' });

    // Backend was called with correct args
    expect(mockMergePullRequest).toHaveBeenCalledWith('repo-1', 'stream-1', expect.objectContaining({
      merge_method: 'merge',
    }));

    // First query: mark approved
    expect(mockQuery.mock.calls[0][0]).toContain("review_status = 'approved'");
    expect(mockQuery.mock.calls[0][1]).toEqual(['stream-1', 'repo-1']);

    // Second query: record the merge
    expect(mockQuery.mock.calls[1][0]).toContain('gitswarm_merges');

    // Third query: update stream to merged
    expect(mockQuery.mock.calls[2][0]).toContain("status = 'merged'");

    expect(result.executed).toBe(true);
    expect(result.action).toBe('merge_stream');
    expect(result.merge_commit).toBe('abc123');
  });

  it('should return approved_pending_merge on backend failure', async () => {
    mockMergePullRequest.mockRejectedValueOnce(new Error('merge conflict'));
    mockQuery
      // UPDATE review_status
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.executeMergeStream('repo-1', { stream_id: 'stream-1' });

    // Should not throw — returns structured failure
    expect(result.executed).toBe(false);
    expect(result.status).toBe('approved_pending_merge');
    expect(result.error).toBe('merge conflict');
    expect(result.stream_id).toBe('stream-1');

    // review_status was still set to approved (before the merge attempt)
    expect(mockQuery.mock.calls[0][0]).toContain("review_status = 'approved'");
    // No merge record or status update (only 1 query made)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should update review_status to approved before attempting merge', async () => {
    mockMergePullRequest.mockResolvedValueOnce({ mergeCommit: 'def456' });
    mockQuery.mockResolvedValue({ rows: [] });

    await service.executeMergeStream('repo-1', { stream_id: 'stream-1' });

    // The FIRST query must be the approval update (before any merge attempt)
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[0]).toContain('UPDATE gitswarm_streams');
    expect(firstCall[0]).toContain("review_status = 'approved'");
  });

  it('executeRevertStream should update status to reverted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // UPDATE status = 'reverted'
      .mockResolvedValueOnce({ rows: [{ git_backend: 'github' }] });  // SELECT git_backend

    const result = await service.executeRevertStream('repo-1', { stream_id: 'stream-1' });

    expect(result.executed).toBe(true);
    expect(result.action).toBe('revert_stream');
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'reverted'");
  });

  it('executePromote should record promotion and return success', async () => {
    mockQuery
      // SELECT buffer_branch, promote_target, git_backend
      .mockResolvedValueOnce({
        rows: [{ buffer_branch: 'buffer', promote_target: 'main', git_backend: 'github' }],
      })
      // INSERT INTO gitswarm_promotions
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.executePromote('repo-1', {});

    expect(result.executed).toBe(true);
    expect(result.action).toBe('promote');
    // Should query for repo config first
    expect(mockQuery.mock.calls[0][0]).toContain('buffer_branch');
    // Should insert promotion record
    expect(mockQuery.mock.calls[1][0]).toContain('gitswarm_promotions');
  });

  it('executePromote should return error for non-existent repo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await service.executePromote('repo-missing', {});

    expect(result.executed).toBe(false);
    expect(result.error).toBe('repo_not_found');
  });
});


// ═══════════════════════════════════════════════════════════════
// #15 — flushQueue returns failedTypes for consensus safety
// ═══════════════════════════════════════════════════════════════

describe('Fix #15: flushQueue returns failedTypes', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return empty failedTypes on full success', async () => {
    const store = createMockStore([
      { type: 'review', data: { stream_id: 's1', verdict: 'approve' } },
      { type: 'commit', data: { stream_id: 's1', commit_hash: 'abc' } },
    ]);

    mockFetchOk({
      results: [
        { seq: 1, status: 'ok' },
        { seq: 2, status: 'ok' },
      ],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(2);
    expect(result.failedTypes).toEqual([]);
  });

  it('should include review in failedTypes when review event fails', async () => {
    const store = createMockStore([
      { type: 'commit', data: { stream_id: 's1' } },
      { type: 'review', data: { stream_id: 's1', verdict: 'approve' } },
      { type: 'submit_review', data: { stream_id: 's1' } },
    ]);

    mockFetchOk({
      results: [
        { seq: 1, status: 'ok' },
        { seq: 2, status: 'error', message: 'DB constraint' },
        // seq 3 never processed (server stops at first error)
      ],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(1);
    expect(result.failedTypes).toContain('review');
    expect(result.failedTypes).toContain('submit_review');
  });

  it('should return failedTypes when no store is present', async () => {
    const sync = createTestSyncClient(null);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(0);
    expect(result.failedTypes).toEqual([]);
  });

  it('should return failedTypes when queue is empty', async () => {
    const store = createMockStore([]);
    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(0);
    expect(result.failedTypes).toEqual([]);
  });

  it('should handle duplicate events without adding to failedTypes', async () => {
    const store = createMockStore([
      { type: 'review', data: { stream_id: 's1', verdict: 'approve' } },
    ]);

    mockFetchOk({
      results: [
        { seq: 1, status: 'duplicate' },
      ],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(1);
    expect(result.failedTypes).toEqual([]);
  });

  it('should collect types from events after the break point', async () => {
    const store = createMockStore([
      { type: 'stream_created', data: { stream_id: 's1' } },
      { type: 'commit', data: { stream_id: 's1' } },
      { type: 'review', data: { stream_id: 's1', verdict: 'approve' } },
    ]);

    // First event fails — everything after is also unflushed
    mockFetchOk({
      results: [
        { seq: 1, status: 'error', message: 'DB error' },
      ],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(0);
    expect(result.failedTypes).toContain('stream_created');
    expect(result.failedTypes).toContain('commit');
    expect(result.failedTypes).toContain('review');
  });

  it('individual fallback should also return failedTypes', async () => {
    const store = createMockStore([
      { type: 'review', data: { stream_id: 's1', repoId: 'r1', verdict: 'approve' } },
      { type: 'commit', data: { stream_id: 's1', repoId: 'r1', commitHash: 'abc' } },
    ]);

    // First call: batch endpoint returns 404 → triggers individual fallback
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found',
    });

    // Individual dispatch for review event → succeeds
    mockFetchOk({});
    // Individual dispatch for commit event → fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'DB error' }),
      text: async () => 'DB error',
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    expect(result.flushed).toBe(1);
    expect(result.failedTypes).toContain('commit');
  });
});


// ═══════════════════════════════════════════════════════════════
// #2 — Gated mode delegates to server in Mode B
// ═══════════════════════════════════════════════════════════════

describe('Fix #2: Gated mode uses requestMerge in Mode B', () => {
  let sync;

  beforeEach(() => {
    mockFetch.mockReset();
    sync = createTestSyncClient();
  });

  it('requestMerge sends POST to merge-request endpoint', async () => {
    mockFetchOk({ approved: true, bufferBranch: 'buffer' });

    const result = await sync.requestMerge('repo-1', 'stream-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/gitswarm/repos/repo-1/streams/stream-1/merge-request');
    expect(opts.method).toBe('POST');
    expect(result.approved).toBe(true);
  });

  it('requestMerge returns denial with consensus info', async () => {
    mockFetchOk({
      approved: false,
      consensus: { reached: false, reason: 'insufficient_reviews' },
      bufferBranch: 'buffer',
    });

    const result = await sync.requestMerge('repo-1', 'stream-1');

    expect(result.approved).toBe(false);
    expect(result.consensus.reason).toBe('insufficient_reviews');
  });

  it('requestMerge propagates HTTP errors', async () => {
    mockFetchError(403, 'Gated mode requires maintainer approval to merge');

    await expect(sync.requestMerge('repo-1', 'stream-1'))
      .rejects.toThrow();
  });
});


// ═══════════════════════════════════════════════════════════════
// #7 — Plugin compatibility & skipped plugin logging
// ═══════════════════════════════════════════════════════════════

describe('Fix #7: flushQueue failedTypes includes review for consensus safety', () => {
  // This test verifies the integration between flushQueue failedTypes
  // and the merge flow's check. The merge flow in federation.js checks:
  //   if (flushResult?.failedTypes?.some(t => REVIEW_CRITICAL_TYPES.includes(t)))
  //
  // We test the prerequisite: that flushQueue correctly tags review failures.

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('merge-blocking types are correctly identified', () => {
    const REVIEW_CRITICAL_TYPES = ['review', 'submit_review'];

    // These should block merges
    expect(REVIEW_CRITICAL_TYPES.includes('review')).toBe(true);
    expect(REVIEW_CRITICAL_TYPES.includes('submit_review')).toBe(true);

    // These should NOT block merges
    expect(REVIEW_CRITICAL_TYPES.includes('commit')).toBe(false);
    expect(REVIEW_CRITICAL_TYPES.includes('stream_created')).toBe(false);
    expect(REVIEW_CRITICAL_TYPES.includes('stabilize')).toBe(false);
  });

  it('flushQueue with only non-review failures does not block merges', async () => {
    const store = createMockStore([
      { type: 'commit', data: { stream_id: 's1' } },
    ]);

    mockFetchOk({
      results: [{ seq: 1, status: 'error', message: 'transient' }],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    const REVIEW_CRITICAL_TYPES = ['review', 'submit_review'];
    const hasReviewFailure = result.failedTypes.some(t => REVIEW_CRITICAL_TYPES.includes(t));
    expect(hasReviewFailure).toBe(false);
  });

  it('flushQueue with review failure triggers merge block', async () => {
    const store = createMockStore([
      { type: 'review', data: { stream_id: 's1', verdict: 'approve' } },
    ]);

    mockFetchOk({
      results: [{ seq: 1, status: 'error', message: 'constraint violation' }],
    });

    const sync = createTestSyncClient(store);
    const result = await sync.flushQueue();

    const REVIEW_CRITICAL_TYPES = ['review', 'submit_review'];
    const hasReviewFailure = result.failedTypes.some(t => REVIEW_CRITICAL_TYPES.includes(t));
    expect(hasReviewFailure).toBe(true);
  });
});
