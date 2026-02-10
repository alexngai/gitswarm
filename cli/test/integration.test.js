/**
 * Integration tests for the Federation class.
 *
 * These tests exercise Federation methods against real git repos
 * (created via helpers.createTestRepo). They verify the interplay
 * between gitswarm policy and git-cascade mechanics.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createTestFederation, writeAndStage, cleanup } from './helpers.js';

afterAll(cleanup);

// ── Federation.init ──────────────────────────────────────

describe('Federation.init', () => {
  it('creates .gitswarm directory with db and config', () => {
    const { federation, config, repoPath } = createTestFederation();
    const swarmDir = join(repoPath, '.gitswarm');

    expect(existsSync(join(swarmDir, 'federation.db'))).toBe(true);
    expect(existsSync(join(swarmDir, 'config.json'))).toBe(true);
    expect(config.merge_mode).toBe('review');
    expect(config.ownership_model).toBe('guild');
    federation.close();
  });

  it('creates buffer branch from HEAD', () => {
    const { federation, repoPath } = createTestFederation();
    const branches = execSync('git branch', { cwd: repoPath, encoding: 'utf-8' });
    expect(branches).toContain('buffer');
    federation.close();
  });

  it('stores repo record with v2 fields', async () => {
    const { federation } = createTestFederation({
      buffer_branch: 'staging',
      promote_target: 'production',
    });
    const repo = await federation.repo();
    expect(repo.merge_mode).toBe('review');
    expect(repo.buffer_branch).toBe('staging');
    expect(repo.promote_target).toBe('production');
    federation.close();
  });

  it('rejects double init', async () => {
    const { federation, repoPath } = createTestFederation();
    const { Federation } = await import('../src/federation.js');
    expect(() => {
      Federation.init(repoPath, { name: 'dup' });
    }).toThrow(/already initialised/i);
    federation.close();
  });
});

// ── Agent registration ───────────────────────────────────

describe('Agent registration', () => {
  it('registers agents with unique keys', async () => {
    const { federation } = createTestFederation();
    const a1 = await federation.registerAgent('architect', 'designs systems');
    const a2 = await federation.registerAgent('coder', 'writes code');

    expect(a1.agent.name).toBe('architect');
    expect(a1.api_key).toMatch(/^gsw_/);
    expect(a2.agent.name).toBe('coder');
    expect(a1.api_key).not.toBe(a2.api_key);

    const agents = await federation.listAgents();
    expect(agents).toHaveLength(2);
    federation.close();
  });

  it('resolves agent by name or id', async () => {
    const { federation } = createTestFederation();
    const { agent } = await federation.registerAgent('finder');
    const byId = await federation.getAgent(agent.id);
    const byName = await federation.getAgent('finder');
    expect(byId.id).toBe(agent.id);
    expect(byName.id).toBe(agent.id);
    federation.close();
  });
});

// ── Workspace lifecycle ──────────────────────────────────

describe('Workspace lifecycle', () => {
  async function setupFedWithAgent(opts = {}) {
    const { federation, repoPath } = createTestFederation(opts);
    const repo = await federation.repo();
    const { agent } = await federation.registerAgent('worker');
    // Grant access — repo defaults to public so agent has write
    return { federation, repoPath, repo, agent };
  }

  it('creates workspace with stream and worktree', async () => {
    const { federation, agent } = await setupFedWithAgent();
    const ws = await federation.createWorkspace({ agentId: agent.id });

    expect(ws.streamId).toBeTruthy();
    expect(ws.path).toContain('.worktrees');
    expect(existsSync(ws.path)).toBe(true);
    federation.close();
  });

  it('lists workspaces', async () => {
    const { federation, agent } = await setupFedWithAgent();
    await federation.createWorkspace({ agentId: agent.id });
    const list = await federation.listWorkspaces();

    expect(list).toHaveLength(1);
    expect(list[0].agentId).toBe(agent.id);
    expect(list[0].agentName).toBe('worker');
    expect(list[0].streamId).toBeTruthy();
    federation.close();
  });

  it('destroys workspace', async () => {
    const { federation, agent } = await setupFedWithAgent();
    const ws = await federation.createWorkspace({ agentId: agent.id });
    const result = await federation.destroyWorkspace(agent.id, { abandonStream: true });
    expect(result.success).toBe(true);

    const list = await federation.listWorkspaces();
    expect(list).toHaveLength(0);
    federation.close();
  });

  it('forks from another stream (dependsOn)', async () => {
    const { federation } = createTestFederation();
    const { agent: a1 } = await federation.registerAgent('lead');
    const { agent: a2 } = await federation.registerAgent('helper');

    const ws1 = await federation.createWorkspace({ agentId: a1.id });
    const ws2 = await federation.createWorkspace({ agentId: a2.id, dependsOn: ws1.streamId });

    expect(ws2.streamId).not.toBe(ws1.streamId);

    // Verify parent/child relationship
    const info = federation.getStreamInfo(ws2.streamId);
    expect(info).not.toBeNull();
    federation.close();
  });
});

// ── Committing ───────────────────────────────────────────

describe('Committing', () => {
  async function setupWorkspace(opts = {}) {
    const { federation, repoPath } = createTestFederation(opts);
    const { agent } = await federation.registerAgent('dev');
    const ws = await federation.createWorkspace({ agentId: agent.id });
    return { federation, repoPath, agent, ws };
  }

  it('commits changes and returns commit hash + changeId', async () => {
    const { federation, agent, ws } = await setupWorkspace();

    writeAndStage(ws.path, 'feature.js', 'console.log("hello");');
    const result = await federation.commit({
      agentId: agent.id,
      message: 'Add feature',
    });

    expect(result.commit).toBeTruthy();
    expect(result.changeId).toBeTruthy();
    expect(result.merged).toBe(false); // review mode, no auto-merge
    federation.close();
  });

  it('auto-merges in swarm mode', async () => {
    const { federation, agent, ws } = await setupWorkspace({ merge_mode: 'swarm' });

    writeAndStage(ws.path, 'auto.js', 'console.log("swarm");');
    const result = await federation.commit({
      agentId: agent.id,
      message: 'Swarm commit',
    });

    expect(result.merged).toBe(true);
    federation.close();
  });

  it('records activity log on commit', async () => {
    const { federation, agent, ws } = await setupWorkspace();

    writeAndStage(ws.path, 'log.js', 'export default 1;');
    await federation.commit({ agentId: agent.id, message: 'Log test' });

    const events = await federation.activity.recent({ agent_id: agent.id, event_type: 'commit' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event_type).toBe('commit');
    federation.close();
  });
});

// ── Review flow ──────────────────────────────────────────

describe('Review flow', () => {
  async function setupReviewable() {
    const { federation, repoPath } = createTestFederation({ ownership_model: 'guild' });
    const { agent: author } = await federation.registerAgent('author');
    const { agent: reviewer } = await federation.registerAgent('reviewer');
    const repo = await federation.repo();

    // Make reviewer a maintainer
    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, reviewer.id]
    );

    const ws = await federation.createWorkspace({ agentId: author.id });
    writeAndStage(ws.path, 'review-me.js', 'export const x = 42;');
    await federation.commit({ agentId: author.id, message: 'Feature for review' });

    return { federation, author, reviewer, repo, ws };
  }

  it('submits stream for review', async () => {
    const { federation, author, ws } = await setupReviewable();
    const result = await federation.submitForReview(ws.streamId, author.id);

    expect(result.streamId).toBe(ws.streamId);
    expect(result.reviewBlocks).toBeDefined();
    federation.close();
  });

  it('records review verdict', async () => {
    const { federation, reviewer, ws } = await setupReviewable();
    await federation.submitForReview(ws.streamId, reviewer.id);

    const review = await federation.submitReview(
      ws.streamId, reviewer.id, 'approve', 'LGTM'
    );

    expect(review.verdict).toBe('approve');
    expect(review.feedback).toBe('LGTM');

    const reviews = await federation.getReviews(ws.streamId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe('approve');
    federation.close();
  });

  it('checks consensus on reviewed stream', async () => {
    const { federation, reviewer, ws } = await setupReviewable();
    await federation.submitForReview(ws.streamId, reviewer.id);

    // Before review: no consensus
    const before = await federation.checkConsensus(ws.streamId);
    expect(before.reached).toBe(false);

    // After maintainer approval: consensus reached
    await federation.submitReview(ws.streamId, reviewer.id, 'approve', 'Ship it');
    const after = await federation.checkConsensus(ws.streamId);
    expect(after.reached).toBe(true);
    federation.close();
  });

  it('rejects consensus on request_changes', async () => {
    const { federation, reviewer, ws } = await setupReviewable();
    await federation.submitForReview(ws.streamId, reviewer.id);
    await federation.submitReview(ws.streamId, reviewer.id, 'request_changes', 'Needs work');

    const result = await federation.checkConsensus(ws.streamId);
    expect(result.reached).toBe(false);
    federation.close();
  });
});

// ── Merge to buffer ──────────────────────────────────────

describe('Merge to buffer', () => {
  async function setupMergeable() {
    const { federation, repoPath } = createTestFederation({ ownership_model: 'guild' });
    const { agent: author } = await federation.registerAgent('author');
    const { agent: reviewer } = await federation.registerAgent('reviewer');
    const repo = await federation.repo();

    // Make reviewer a maintainer
    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, reviewer.id]
    );

    const ws = await federation.createWorkspace({ agentId: author.id });
    writeAndStage(ws.path, 'merge-me.js', 'export const y = 99;');
    await federation.commit({ agentId: author.id, message: 'Mergeable feature' });
    await federation.submitForReview(ws.streamId, author.id);
    await federation.submitReview(ws.streamId, reviewer.id, 'approve', 'OK');

    return { federation, repoPath, author, reviewer, repo, ws };
  }

  it('merges after consensus in review mode', async () => {
    const { federation, author, ws } = await setupMergeable();
    const result = await federation.mergeToBuffer(ws.streamId, author.id);

    expect(result.streamId).toBe(ws.streamId);
    expect(result.mergeResult).toBeDefined();
    expect(result.mergeResult.success).toBe(true);
    federation.close();
  });

  it('rejects merge without consensus', async () => {
    const { federation, repoPath } = createTestFederation({ ownership_model: 'guild' });
    const { agent } = await federation.registerAgent('solo-dev');
    const ws = await federation.createWorkspace({ agentId: agent.id });

    writeAndStage(ws.path, 'nope.js', 'export default null;');
    await federation.commit({ agentId: agent.id, message: 'Uncommitted' });

    await expect(federation.mergeToBuffer(ws.streamId, agent.id))
      .rejects.toThrow(/consensus not reached/i);
    federation.close();
  });

  it('updates stage metrics after merge', async () => {
    const { federation, author, repo, ws } = await setupMergeable();
    await federation.mergeToBuffer(ws.streamId, author.id);

    const metrics = await federation.stages.getStageMetrics(repo.id);
    expect(metrics.metrics).toBeDefined();
    federation.close();
  });
});

// ── Stream inspection ────────────────────────────────────

describe('Stream inspection', () => {
  it('lists active streams', async () => {
    const { federation } = createTestFederation();
    const { agent: a1 } = await federation.registerAgent('streamer1');
    const { agent: a2 } = await federation.registerAgent('streamer2');

    await federation.createWorkspace({ agentId: a1.id });
    await federation.createWorkspace({ agentId: a2.id });

    // The buffer tracking stream + 2 agent streams
    const streams = federation.listActiveStreams();
    expect(streams.length).toBeGreaterThanOrEqual(2);
    federation.close();
  });

  it('getStreamInfo returns details', async () => {
    const { federation } = createTestFederation();
    const { agent } = await federation.registerAgent('infodev');
    const ws = await federation.createWorkspace({ agentId: agent.id });

    const info = federation.getStreamInfo(ws.streamId);
    expect(info).not.toBeNull();
    expect(info.stream.agentId).toBe(agent.id);
    expect(info.stream.status).toBe('active');
    federation.close();
  });

  it('getStreamDiff returns diff stat', async () => {
    const { federation } = createTestFederation();
    const { agent } = await federation.registerAgent('diffdev');
    const ws = await federation.createWorkspace({ agentId: agent.id });

    writeAndStage(ws.path, 'diff-test.js', 'const z = 1;');
    await federation.commit({ agentId: agent.id, message: 'Diff test' });

    const diff = federation.getStreamDiff(ws.streamId);
    expect(diff).toContain('diff-test.js');
    federation.close();
  });
});

// ── Promotion ────────────────────────────────────────────

describe('Promotion', () => {
  it('promotes buffer to main via ff-merge', async () => {
    const { federation, repoPath } = createTestFederation({ ownership_model: 'guild' });
    const { agent: author } = await federation.registerAgent('promoter');
    const { agent: reviewer } = await federation.registerAgent('approver');
    const repo = await federation.repo();

    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, reviewer.id]
    );

    const ws = await federation.createWorkspace({ agentId: author.id });
    writeAndStage(ws.path, 'promote-feature.js', 'export default "promoted";');
    await federation.commit({ agentId: author.id, message: 'Promotable feature' });
    await federation.submitForReview(ws.streamId, author.id);
    await federation.submitReview(ws.streamId, reviewer.id, 'approve', 'Ship it');
    await federation.mergeToBuffer(ws.streamId, author.id);

    const result = await federation.promote();
    expect(result.success).toBe(true);
    expect(result.from).toBe('buffer');
    expect(result.to).toBe('main');

    // Verify main has the file
    const mainContent = execSync(
      'git show main:promote-feature.js 2>/dev/null || echo ""',
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim();
    expect(mainContent).toContain('promoted');
    federation.close();
  });
});
