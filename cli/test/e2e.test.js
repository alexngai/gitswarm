/**
 * End-to-end tests for the full git-cascade flow.
 *
 * Each test exercises the complete lifecycle:
 *   init → register → workspace → write → commit → review → merge → promote
 *
 * These tests use real git repos and verify actual file content.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createTestFederation, writeAndStage, cleanup } from './helpers.js';

afterAll(cleanup);

// ── Full review-mode flow ────────────────────────────────

describe('E2E: review mode (full lifecycle)', () => {
  it('workspace → commit → review → merge → promote', async () => {
    // 1. Init federation in review mode
    const { federation, repoPath } = createTestFederation({
      merge_mode: 'review',
      ownership_model: 'guild',
    });
    const repo = await federation.repo();
    expect(repo.merge_mode).toBe('review');

    // 2. Register agents
    const { agent: architect } = await federation.registerAgent('architect', 'designs systems');
    const { agent: coder } = await federation.registerAgent('coder', 'writes code');
    const { agent: reviewer } = await federation.registerAgent('reviewer', 'reviews code');

    // Make architect and reviewer maintainers
    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'owner')",
      [repo.id, architect.id]
    );
    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, reviewer.id]
    );

    const agents = await federation.listAgents();
    expect(agents).toHaveLength(3);

    // 3. Coder creates workspace
    const ws = await federation.createWorkspace({
      agentId: coder.id,
      name: 'coder/feature-auth',
    });
    expect(ws.streamId).toBeTruthy();
    expect(existsSync(ws.path)).toBe(true);

    // 4. Coder writes files and commits
    writeAndStage(ws.path, 'auth.js', `
export class Auth {
  login(user, pass) {
    return { token: 'abc123', user };
  }
  logout() {
    return { success: true };
  }
}
`);
    writeAndStage(ws.path, 'auth.test.js', `
import { Auth } from './auth.js';
const auth = new Auth();
console.assert(auth.login('u', 'p').token === 'abc123');
console.log('auth tests pass');
`);

    const commitResult = await federation.commit({
      agentId: coder.id,
      message: 'Add authentication module',
    });
    expect(commitResult.commit).toBeTruthy();
    expect(commitResult.changeId).toBeTruthy();
    expect(commitResult.merged).toBe(false);

    // 5. Submit for review
    const review = await federation.submitForReview(ws.streamId, coder.id);
    expect(review.streamId).toBe(ws.streamId);

    // 6. Reviewer reviews — first check no consensus
    const noConsensus = await federation.checkConsensus(ws.streamId);
    expect(noConsensus.reached).toBe(false);

    // 7. Maintainer approves
    await federation.submitReview(ws.streamId, reviewer.id, 'approve', 'Clean implementation');

    // 8. Consensus reached
    const consensus = await federation.checkConsensus(ws.streamId);
    expect(consensus.reached).toBe(true);

    // 9. Merge to buffer
    const mergeResult = await federation.mergeToBuffer(ws.streamId, coder.id);
    expect(mergeResult.streamId).toBe(ws.streamId);
    expect(mergeResult.mergeResult.success).toBe(true);

    // Verify file exists on buffer branch
    const bufferContent = execSync(
      'git show buffer:auth.js',
      { cwd: repoPath, encoding: 'utf-8' }
    );
    expect(bufferContent).toContain('class Auth');

    // 10. Promote buffer to main
    const promoteResult = await federation.promote();
    expect(promoteResult.success).toBe(true);
    expect(promoteResult.from).toBe('buffer');
    expect(promoteResult.to).toBe('main');

    // Verify main has the feature
    const mainContent = execSync(
      'git show main:auth.js',
      { cwd: repoPath, encoding: 'utf-8' }
    );
    expect(mainContent).toContain('class Auth');

    // 11. Activity log has the full trail
    const events = await federation.activity.recent({ limit: 20 });
    const eventTypes = events.map(e => e.event_type);
    expect(eventTypes).toContain('workspace_created');
    expect(eventTypes).toContain('commit');
    expect(eventTypes).toContain('submit_for_review');
    expect(eventTypes).toContain('review_submitted');
    expect(eventTypes).toContain('stream_merged');
    expect(eventTypes).toContain('promote');

    federation.close();
  });
});

// ── Swarm mode: auto-merge on commit ─────────────────────

describe('E2E: swarm mode (auto-merge)', () => {
  it('commit auto-merges to buffer without review', async () => {
    const { federation, repoPath } = createTestFederation({
      merge_mode: 'swarm',
      ownership_model: 'guild',
    });

    const { agent } = await federation.registerAgent('fast-dev');
    const ws = await federation.createWorkspace({ agentId: agent.id });

    writeAndStage(ws.path, 'quick.js', 'export const speed = "fast";');
    const result = await federation.commit({
      agentId: agent.id,
      message: 'Quick swarm commit',
    });

    expect(result.merged).toBe(true);

    // Buffer should have the file
    const content = execSync(
      'git show buffer:quick.js',
      { cwd: repoPath, encoding: 'utf-8' }
    );
    expect(content).toContain('fast');

    federation.close();
  });
});

// ── Multi-agent concurrent streams ───────────────────────

describe('E2E: multi-agent concurrent work', () => {
  it('two agents work in parallel, both merge to buffer', async () => {
    const { federation, repoPath } = createTestFederation({
      merge_mode: 'review',
      ownership_model: 'guild',
    });
    const repo = await federation.repo();

    const { agent: a1 } = await federation.registerAgent('agent-alpha');
    const { agent: a2 } = await federation.registerAgent('agent-beta');
    const { agent: maintainer } = await federation.registerAgent('maintainer');

    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, maintainer.id]
    );

    // Agent Alpha creates workspace and commits
    const ws1 = await federation.createWorkspace({ agentId: a1.id, name: 'alpha/feature' });
    writeAndStage(ws1.path, 'alpha.js', 'export const who = "alpha";');
    await federation.commit({ agentId: a1.id, message: 'Alpha feature' });
    await federation.submitForReview(ws1.streamId, a1.id);

    // Agent Beta creates workspace and commits
    const ws2 = await federation.createWorkspace({ agentId: a2.id, name: 'beta/feature' });
    writeAndStage(ws2.path, 'beta.js', 'export const who = "beta";');
    await federation.commit({ agentId: a2.id, message: 'Beta feature' });
    await federation.submitForReview(ws2.streamId, a2.id);

    // Both have active streams
    const streams = federation.listActiveStreams();
    const agentStreams = streams.filter(s =>
      s.agentId === a1.id || s.agentId === a2.id
    );
    expect(agentStreams).toHaveLength(2);

    // Maintainer approves both
    await federation.submitReview(ws1.streamId, maintainer.id, 'approve', 'OK');
    await federation.submitReview(ws2.streamId, maintainer.id, 'approve', 'OK');

    // Merge both to buffer (sequential — merge queue handles ordering)
    await federation.mergeToBuffer(ws1.streamId, a1.id);
    await federation.mergeToBuffer(ws2.streamId, a2.id);

    // Buffer should have both files
    const alphaContent = execSync(
      'git show buffer:alpha.js',
      { cwd: repoPath, encoding: 'utf-8' }
    );
    const betaContent = execSync(
      'git show buffer:beta.js',
      { cwd: repoPath, encoding: 'utf-8' }
    );
    expect(alphaContent).toContain('alpha');
    expect(betaContent).toContain('beta');

    // Promote everything to main
    const promoteResult = await federation.promote();
    expect(promoteResult.success).toBe(true);

    federation.close();
  });
});

// ── Task-linked workflow ─────────────────────────────────

describe('E2E: task-linked workflow', () => {
  it('creates task, claims, links to stream, and submits', async () => {
    const { federation } = createTestFederation();
    const repo = await federation.repo();
    const { agent: lead } = await federation.registerAgent('lead');
    const { agent: dev } = await federation.registerAgent('dev');

    // Make lead a maintainer (needed for merge)
    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'owner')",
      [repo.id, lead.id]
    );

    // Lead creates a task
    const task = await federation.tasks.create(repo.id, {
      title: 'Implement caching layer',
      priority: 'high',
    }, lead.id);
    expect(task.status).toBe('open');

    // Dev claims the task
    const claim = await federation.tasks.claim(task.id, dev.id);
    expect(claim.status).toBe('active');

    // Dev creates workspace and links to task
    const ws = await federation.createWorkspace({
      agentId: dev.id,
      taskId: task.id,
      name: 'dev/caching',
    });
    expect(ws.streamId).toBeTruthy();

    // Dev writes code and commits
    writeAndStage(ws.path, 'cache.js', 'export class Cache { get(k) { return null; } }');
    await federation.commit({ agentId: dev.id, message: 'Implement caching' });

    // Dev submits the task with stream_id
    const submission = await federation.tasks.submit(claim.id, dev.id, {
      stream_id: ws.streamId,
      notes: 'Caching layer done',
    });
    expect(submission.status).toBe('submitted');
    expect(submission.stream_id).toBe(ws.streamId);

    // Verify claim is linked to stream
    const linkedClaim = await federation.tasks.getClaimByStream(ws.streamId);
    expect(linkedClaim).not.toBeNull();

    federation.close();
  });
});

// ── Stream forking (dependency chains) ───────────────────

describe('E2E: stream forking', () => {
  it('child stream forks from parent and both are tracked', async () => {
    const { federation, repoPath } = createTestFederation({
      merge_mode: 'review',
      ownership_model: 'guild',
    });
    const repo = await federation.repo();

    const { agent: a1 } = await federation.registerAgent('base-dev');
    const { agent: a2 } = await federation.registerAgent('fork-dev');
    const { agent: maintainer } = await federation.registerAgent('admin');

    federation.store.query(
      "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
      [repo.id, maintainer.id]
    );

    // First agent creates base workspace with a file
    const ws1 = await federation.createWorkspace({ agentId: a1.id, name: 'base/api' });
    writeAndStage(ws1.path, 'api.js', 'export function getUsers() { return []; }');
    await federation.commit({ agentId: a1.id, message: 'Add base API' });

    // Second agent forks from the first
    const ws2 = await federation.createWorkspace({
      agentId: a2.id,
      dependsOn: ws1.streamId,
      name: 'fork/api-extension',
    });

    // Fork should be tracked
    const info = federation.getStreamInfo(ws2.streamId);
    expect(info).not.toBeNull();
    expect(info.stream.status).toBe('active');

    // Second agent adds to the fork
    writeAndStage(ws2.path, 'api-ext.js', 'export function getAdmins() { return []; }');
    await federation.commit({ agentId: a2.id, message: 'Extend API with admin endpoint' });

    // Both streams visible
    const streams = federation.listActiveStreams();
    const ids = streams.map(s => s.id);
    expect(ids).toContain(ws1.streamId);
    expect(ids).toContain(ws2.streamId);

    federation.close();
  });
});

// ── Council governance + merge_stream proposal ───────────

describe('E2E: council governance', () => {
  it('council creates proposal to merge a stream', async () => {
    const { federation } = createTestFederation({
      merge_mode: 'gated',
      ownership_model: 'guild',
    });
    const repo = await federation.repo();

    // Register agents
    const { agent: chair } = await federation.registerAgent('council-chair');
    const { agent: member1 } = await federation.registerAgent('council-member1');
    const { agent: member2 } = await federation.registerAgent('council-member2');
    const { agent: dev } = await federation.registerAgent('developer');

    // All are maintainers (for gated mode)
    for (const a of [chair, member1, member2]) {
      federation.store.query(
        "INSERT INTO maintainers (repo_id, agent_id, role) VALUES (?, ?, 'maintainer')",
        [repo.id, a.id]
      );
    }

    // Create council
    const council = await federation.council.create(repo.id, {
      min_members: 2,
      standard_quorum: 2,
    });
    expect(council.status).toBe('forming');

    // Add members
    await federation.council.addMember(council.id, chair.id, 'chair');
    await federation.council.addMember(council.id, member1.id);
    await federation.council.addMember(council.id, member2.id);

    const updated = await federation.council.getCouncil(repo.id);
    expect(updated.status).toBe('active');

    // Developer creates workspace and makes changes
    const ws = await federation.createWorkspace({ agentId: dev.id });
    writeAndStage(ws.path, 'governed.js', 'export const governed = true;');
    await federation.commit({ agentId: dev.id, message: 'Governed feature' });

    // Maintainer reviews to satisfy consensus
    await federation.submitForReview(ws.streamId, dev.id);
    await federation.submitReview(ws.streamId, chair.id, 'approve', 'Approved by council');

    // Council creates proposal to merge the stream
    const proposal = await federation.council.createProposal(council.id, chair.id, {
      title: `Merge stream ${ws.streamId}`,
      proposal_type: 'merge_stream',
      action_data: { stream_id: ws.streamId },
    });
    expect(proposal.status).toBe('open');

    // Vote on it
    await federation.council.vote(proposal.id, chair.id, 'for');
    await federation.council.vote(proposal.id, member1.id, 'for');

    // Proposal should pass
    const proposals = await federation.council.listProposals(council.id);
    const merged = proposals.find(p => p.id === proposal.id);
    expect(merged.status).toBe('passed');

    federation.close();
  });
});

// ── Stage progression ────────────────────────────────────

describe('E2E: stage progression', () => {
  it('advances repo stage based on metrics', async () => {
    const { federation } = createTestFederation({
      merge_mode: 'review',
      ownership_model: 'guild',
    });
    const repo = await federation.repo();

    // Seed stage initially
    const initial = await federation.stages.getStageMetrics(repo.id);
    expect(initial.current_stage).toBe('seed');

    // Check eligibility — should not be eligible yet
    const elig = await federation.stages.checkAdvancementEligibility(repo.id);
    expect(elig.eligible).toBe(false);
    expect(elig.next_stage).toBe('growth');

    // Force advance to growth
    const advance = await federation.stages.advanceStage(repo.id, true);
    expect(advance.success).toBe(true);
    expect(advance.new_stage).toBe('growth');

    // Verify history
    const history = await federation.stages.getStageHistory(repo.id);
    expect(history).toHaveLength(1);
    expect(history[0].from_stage).toBe('seed');
    expect(history[0].to_stage).toBe('growth');

    federation.close();
  });
});
