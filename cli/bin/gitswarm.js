#!/usr/bin/env node

/**
 * gitswarm — standalone CLI for local multi-agent federation coordination.
 *
 * Usage:
 *   gitswarm init [--name <name>] [--model solo|guild|open] [--mode swarm|review|gated]
 *   gitswarm agent register <name> [--desc <description>]
 *   gitswarm agent list
 *   gitswarm agent info <name|id>
 *   gitswarm workspace create --as <agent> [--name <n>] [--task <id>] [--fork <stream>]
 *   gitswarm workspace list
 *   gitswarm workspace destroy <agent> [--abandon]
 *   gitswarm commit --as <agent> -m <message>
 *   gitswarm stream list [--status <s>]
 *   gitswarm stream info <stream-id>
 *   gitswarm stream diff <stream-id>
 *   gitswarm review submit <stream-id> approve|request_changes --as <agent> [--feedback <f>]
 *   gitswarm review list <stream-id>
 *   gitswarm review check <stream-id>
 *   gitswarm merge <stream-id> --as <agent>
 *   gitswarm stabilize
 *   gitswarm promote [--tag <t>]
 *   gitswarm task create <title> [--desc <d>] [--priority <p>] [--as <agent>]
 *   gitswarm task list [--status <s>]
 *   gitswarm task claim <id> --as <agent>
 *   gitswarm task submit <claim-id> --as <agent> [--notes <n>]
 *   gitswarm task review <claim-id> approve|reject --as <agent> [--notes <n>]
 *   gitswarm council create [--min-karma <n>] [--quorum <n>]
 *   gitswarm council propose <type> <title> --as <agent>
 *   gitswarm council vote <proposal-id> for|against --as <agent>
 *   gitswarm council status
 *   gitswarm status
 *   gitswarm log [--limit <n>]
 *   gitswarm config [key] [value]
 */

import { resolve } from 'path';
import { Federation } from '../src/federation.js';

// ── Argument parsing ───────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && i + 1 < args.length) {
      // Special handling for -m <message>
      flags.m = args[++i];
    } else if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = args[++i];
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

// ── Formatting helpers ─────────────────────────────────────

function table(rows, columns) {
  if (rows.length === 0) { console.log('  (none)'); return; }
  const widths = columns.map(c =>
    Math.max(c.label.length, ...rows.map(r => String(c.get(r) ?? '').length))
  );
  const header = columns.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${widths.map(w => '─'.repeat(w)).join('──')}`);
  for (const row of rows) {
    const line = columns.map((c, i) => String(c.get(row) ?? '').padEnd(widths[i])).join('  ');
    console.log(`  ${line}`);
  }
}

function short(id) {
  return id ? id.slice(0, 8) : '—';
}

function timeAgo(ts) {
  if (!ts) return '—';
  const ms = typeof ts === 'number' ? Date.now() - ts : Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Commands ───────────────────────────────────────────────

const commands = {};

// --- init ---
commands.init = (_fed, { flags }) => {
  const cwd = resolve(process.cwd());
  try {
    const { config } = Federation.init(cwd, {
      name: flags.name,
      merge_mode: flags.mode,
      ownership_model: flags.model,
      agent_access: flags.access,
      consensus_threshold: flags.threshold ? parseFloat(flags.threshold) : undefined,
      min_reviews: flags['min-reviews'] ? parseInt(flags['min-reviews']) : undefined,
      buffer_branch: flags['buffer-branch'],
      promote_target: flags['promote-target'],
      stabilize_command: flags['stabilize-command'],
    });
    console.log(`Initialised gitswarm federation: ${config.name}`);
    console.log(`  mode:      ${config.merge_mode}`);
    console.log(`  model:     ${config.ownership_model}`);
    console.log(`  access:    ${config.agent_access}`);
    console.log(`  consensus: ${config.consensus_threshold}`);
    console.log(`  store:     .gitswarm/federation.db`);
    console.log('\nNext steps:');
    console.log('  gitswarm agent register <name>       Register an agent');
    console.log('  gitswarm workspace create --as <a>   Create an isolated workspace');
    console.log('  gitswarm task create <title>          Create a task');
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
};

// --- agent ---
commands.agent = async (fed, { positional, flags }) => {
  const sub = positional[0];

  if (sub === 'register') {
    const name = positional[1] || flags.name;
    if (!name) { console.error('Usage: gitswarm agent register <name>'); process.exit(1); }
    const { agent, api_key } = await fed.registerAgent(name, flags.desc || '');
    console.log(`Agent registered: ${agent.name}`);
    console.log(`  id:      ${agent.id}`);
    console.log(`  api_key: ${api_key}  (save this — shown only once)`);
    return;
  }

  if (sub === 'list') {
    const agents = await fed.listAgents();
    table(agents, [
      { label: 'ID',     get: r => short(r.id) },
      { label: 'NAME',   get: r => r.name },
      { label: 'KARMA',  get: r => r.karma },
      { label: 'STATUS', get: r => r.status },
      { label: 'CREATED', get: r => r.created_at?.slice(0, 10) },
    ]);
    return;
  }

  if (sub === 'info') {
    const ref = positional[1];
    if (!ref) { console.error('Usage: gitswarm agent info <name|id>'); process.exit(1); }
    const agent = await fed.getAgent(ref);
    if (!agent) { console.error(`Agent not found: ${ref}`); process.exit(1); }
    console.log(`Agent: ${agent.name}`);
    console.log(`  id:          ${agent.id}`);
    console.log(`  karma:       ${agent.karma}`);
    console.log(`  status:      ${agent.status}`);
    console.log(`  description: ${agent.description || '—'}`);
    console.log(`  created:     ${agent.created_at}`);
    return;
  }

  console.error('Usage: gitswarm agent <register|list|info>');
  process.exit(1);
};

// --- workspace ---
commands.workspace = async (fed, { positional, flags }) => {
  const sub = positional[0];

  if (sub === 'create') {
    if (!flags.as) {
      console.error('Usage: gitswarm workspace create --as <agent> [--name <n>] [--task <id>] [--fork <stream>]');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    const taskId = flags.task ? await resolveId(fed, 'tasks', flags.task) : undefined;
    const ws = await fed.createWorkspace({
      agentId: agent.id,
      name: flags.name,
      taskId,
      dependsOn: flags.fork,
    });
    console.log(`Workspace created for ${agent.name}`);
    console.log(`  stream: ${ws.streamId}`);
    console.log(`  path:   ${ws.path}`);
    return;
  }

  if (sub === 'list') {
    const workspaces = await fed.listWorkspaces();
    table(workspaces, [
      { label: 'AGENT',   get: r => r.agentName },
      { label: 'STREAM',  get: r => short(r.streamId) },
      { label: 'NAME',    get: r => r.streamName || '—' },
      { label: 'STATUS',  get: r => r.streamStatus || '—' },
      { label: 'ACTIVE',  get: r => timeAgo(r.lastActive) },
      { label: 'PATH',    get: r => r.path },
    ]);
    return;
  }

  if (sub === 'destroy') {
    const agentRef = positional[1];
    if (!agentRef) { console.error('Usage: gitswarm workspace destroy <agent> [--abandon]'); process.exit(1); }
    const agent = await fed.resolveAgent(agentRef);
    await fed.destroyWorkspace(agent.id, { abandonStream: !!flags.abandon });
    console.log(`Workspace destroyed for ${agent.name}`);
    return;
  }

  console.error('Usage: gitswarm workspace <create|list|destroy>');
  process.exit(1);
};

// --- commit ---
commands.commit = async (fed, { flags }) => {
  if (!flags.as || !flags.m) {
    console.error('Usage: gitswarm commit --as <agent> -m <message>');
    process.exit(1);
  }
  const agent = await fed.resolveAgent(flags.as);
  const result = await fed.commit({
    agentId: agent.id,
    message: flags.m,
    streamId: flags.stream,
  });
  console.log(`Committed: ${result.commit?.slice(0, 8)}`);
  console.log(`  Change-Id: ${result.changeId}`);
  if (result.merged) console.log(`  Auto-merged to buffer (swarm mode)`);
  if (result.conflicts) console.log(`  Merge conflicts: ${result.conflicts.length} files`);
  if (result.mergeError) console.log(`  Merge error: ${result.mergeError}`);
};

// --- stream ---
commands.stream = async (fed, { positional, flags }) => {
  const sub = positional[0];

  if (sub === 'list') {
    const streams = fed._ensureTracker().listStreams({
      status: flags.status || undefined,
    });
    table(streams, [
      { label: 'ID',      get: r => short(r.id) },
      { label: 'NAME',    get: r => r.name },
      { label: 'AGENT',   get: r => short(r.agentId) },
      { label: 'STATUS',  get: r => r.status },
      { label: 'PARENT',  get: r => r.parentStream ? short(r.parentStream) : '—' },
      { label: 'UPDATED', get: r => timeAgo(r.updatedAt) },
    ]);
    return;
  }

  if (sub === 'info') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm stream info <stream-id>'); process.exit(1); }
    const info = fed.getStreamInfo(streamId);
    if (!info) { console.error(`Stream not found: ${streamId}`); process.exit(1); }
    const { stream, changes, operations, dependencies, children } = info;
    console.log(`Stream: ${stream.name}`);
    console.log(`  id:     ${stream.id}`);
    console.log(`  agent:  ${stream.agentId}`);
    console.log(`  status: ${stream.status}`);
    console.log(`  base:   ${stream.baseCommit?.slice(0, 8) || '—'}`);
    console.log(`  parent: ${stream.parentStream || '—'}`);
    console.log(`  changes:    ${changes.length}`);
    console.log(`  operations: ${operations.length}`);
    console.log(`  deps:       ${dependencies.length}`);
    console.log(`  children:   ${children.length}`);
    return;
  }

  if (sub === 'diff') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm stream diff <stream-id>'); process.exit(1); }
    const diff = flags.full ? fed.getStreamDiffFull(streamId) : fed.getStreamDiff(streamId);
    console.log(diff || '(no changes)');
    return;
  }

  console.error('Usage: gitswarm stream <list|info|diff>');
  process.exit(1);
};

// --- review (stream-based) ---
commands.review = async (fed, { positional, flags }) => {
  const sub = positional[0];

  if (sub === 'submit') {
    const streamId = positional[1];
    const verdict = positional[2];
    if (!streamId || !verdict || !flags.as) {
      console.error('Usage: gitswarm review submit <stream-id> approve|request_changes --as <agent> [--feedback <f>]');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    await fed.submitReview(streamId, agent.id, verdict, flags.feedback || '', {
      isHuman: !!flags.human,
    });
    console.log(`Review submitted: ${verdict}`);
    return;
  }

  if (sub === 'list') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm review list <stream-id>'); process.exit(1); }
    const reviews = await fed.getReviews(streamId);
    table(reviews, [
      { label: 'REVIEWER', get: r => r.reviewer_name || short(r.reviewer_id) },
      { label: 'VERDICT',  get: r => r.verdict },
      { label: 'HUMAN',    get: r => r.is_human ? 'yes' : 'no' },
      { label: 'FEEDBACK', get: r => (r.feedback || '').slice(0, 50) },
      { label: 'DATE',     get: r => r.reviewed_at?.slice(0, 10) },
    ]);
    return;
  }

  if (sub === 'check') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm review check <stream-id>'); process.exit(1); }
    const result = await fed.checkConsensus(streamId);
    console.log(`Consensus: ${result.reached ? 'REACHED' : 'NOT REACHED'}`);
    console.log(`  reason: ${result.reason}`);
    if (result.ratio !== undefined) console.log(`  ratio:  ${result.ratio} (threshold: ${result.threshold})`);
    if (result.approvals !== undefined) console.log(`  approvals: ${result.approvals}  rejections: ${result.rejections}`);
    return;
  }

  console.error('Usage: gitswarm review <submit|list|check>');
  process.exit(1);
};

// --- merge ---
commands.merge = async (fed, { positional, flags }) => {
  const streamId = positional[0];
  if (!streamId || !flags.as) {
    console.error('Usage: gitswarm merge <stream-id> --as <agent>');
    process.exit(1);
  }
  const agent = await fed.resolveAgent(flags.as);
  const result = await fed.mergeToBuffer(streamId, agent.id);
  console.log(`Merge queued: ${short(result.entryId)}`);
  if (result.queueResult) {
    console.log(`  processed: ${result.queueResult.processed || 0}`);
    console.log(`  merged: ${result.queueResult.merged || 0}`);
  }
};

// --- stabilize ---
commands.stabilize = async (fed) => {
  const result = await fed.stabilize();
  if (result.success) {
    console.log(`Stabilization: GREEN`);
    console.log(`  tag: ${result.tag}`);
    if (result.promoted) console.log(`  promoted to main`);
  } else {
    console.log(`Stabilization: RED`);
    if (result.output) console.log(`  output: ${result.output.slice(0, 200)}`);
    if (result.reverted) console.log(`  reverted stream: ${result.reverted.streamId}`);
    if (result.revertError) console.log(`  revert error: ${result.revertError}`);
  }
};

// --- promote ---
commands.promote = async (fed, { flags }) => {
  const result = await fed.promote({ tag: flags.tag });
  console.log(`Promoted: ${result.from} → ${result.to}`);
};

// --- task ---
commands.task = async (fed, { positional, flags }) => {
  const repo = await fed.repo();
  if (!repo) { console.error('No repo found. Run gitswarm init first.'); process.exit(1); }
  const sub = positional[0];

  if (sub === 'create') {
    const title = positional.slice(1).join(' ') || flags.title;
    if (!title) { console.error('Usage: gitswarm task create <title> [--as <agent>]'); process.exit(1); }
    const agent = flags.as ? await fed.resolveAgent(flags.as) : null;
    const task = await fed.tasks.create(repo.id, {
      title,
      description: flags.desc || '',
      priority: flags.priority || 'medium',
      amount: flags.amount ? parseInt(flags.amount) : 0,
      difficulty: flags.difficulty,
    }, agent?.id);
    console.log(`Task created: ${short(task.id)}  ${task.title}`);
    return;
  }

  if (sub === 'list') {
    const tasks = await fed.tasks.list(repo.id, { status: flags.status });
    table(tasks, [
      { label: 'ID',       get: r => short(r.id) },
      { label: 'STATUS',   get: r => r.status },
      { label: 'PRIORITY', get: r => r.priority },
      { label: 'TITLE',    get: r => r.title },
      { label: 'CLAIMS',   get: r => r.active_claims || 0 },
      { label: 'CREATOR',  get: r => r.creator_name || '—' },
    ]);
    return;
  }

  if (sub === 'claim') {
    const taskId = positional[1];
    if (!taskId || !flags.as) { console.error('Usage: gitswarm task claim <id> --as <agent>'); process.exit(1); }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'tasks', taskId);
    const claim = await fed.tasks.claim(fullId, agent.id, flags.stream);
    console.log(`Task claimed: ${short(claim.id)}`);
    if (claim.stream_id) console.log(`  stream: ${claim.stream_id}`);

    // Mode B: sync task claim to server
    if (fed.sync) {
      try {
        await fed.sync.claimTask(repo.id, fullId, { streamId: flags.stream });
      } catch {
        fed.sync._queueEvent({ type: 'task_claim', data: {
          repoId: repo.id, taskId: fullId, streamId: flags.stream,
        }});
      }
    }
    return;
  }

  if (sub === 'submit') {
    const claimId = positional[1];
    if (!claimId || !flags.as) { console.error('Usage: gitswarm task submit <claim-id> --as <agent>'); process.exit(1); }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'task_claims', claimId);
    const result = await fed.tasks.submit(fullId, agent.id, {
      stream_id: flags.stream,
      notes: flags.notes || '',
    });
    console.log(`Submission recorded: ${short(result.id)}`);

    // Mode B: sync task submission to server
    if (fed.sync) {
      try {
        await fed.sync.syncTaskSubmission(repo.id, result.task_id, fullId, {
          streamId: result.stream_id,
          notes: flags.notes || '',
        });
      } catch {
        fed.sync._queueEvent({ type: 'task_submission', data: {
          repoId: repo.id, taskId: result.task_id, claimId: fullId,
          streamId: result.stream_id, notes: flags.notes || '',
        }});
      }
    }
    return;
  }

  if (sub === 'review') {
    const claimId = positional[1];
    const decision = positional[2];
    if (!claimId || !decision || !flags.as) {
      console.error('Usage: gitswarm task review <claim-id> approve|reject --as <agent>');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'task_claims', claimId);
    const result = await fed.tasks.review(fullId, agent.id, decision, flags.notes);
    console.log(`Review: ${result.action}`);
    return;
  }

  console.error('Usage: gitswarm task <create|list|claim|submit|review>');
  process.exit(1);
};

// --- council ---
commands.council = async (fed, { positional, flags }) => {
  const repo = await fed.repo();
  if (!repo) { console.error('No repo found.'); process.exit(1); }
  const sub = positional[0];

  if (sub === 'create') {
    const council = await fed.council.create(repo.id, {
      min_karma: flags['min-karma'] ? parseInt(flags['min-karma']) : undefined,
      min_contributions: flags['min-contribs'] ? parseInt(flags['min-contribs']) : undefined,
      min_members: flags['min-members'] ? parseInt(flags['min-members']) : undefined,
      max_members: flags['max-members'] ? parseInt(flags['max-members']) : undefined,
      standard_quorum: flags.quorum ? parseInt(flags.quorum) : undefined,
      critical_quorum: flags['critical-quorum'] ? parseInt(flags['critical-quorum']) : undefined,
    });
    console.log(`Council created: ${short(council.id)}  status: ${council.status}`);
    return;
  }

  if (sub === 'status') {
    const council = await fed.council.getCouncil(repo.id);
    if (!council) { console.log('No council for this repo.'); return; }
    const members = await fed.council.getMembers(council.id);
    const proposals = await fed.council.listProposals(council.id, 'open');
    console.log(`Council: ${council.status}`);
    console.log(`  members: ${members.length}/${council.max_members}  (min: ${council.min_members})`);
    console.log(`  quorum: ${council.standard_quorum} (critical: ${council.critical_quorum})`);
    console.log(`  open proposals: ${proposals.length}`);
    if (members.length > 0) {
      console.log('\nMembers:');
      table(members, [
        { label: 'NAME',  get: r => r.agent_name },
        { label: 'ROLE',  get: r => r.role },
        { label: 'KARMA', get: r => r.karma },
        { label: 'VOTES', get: r => r.votes_cast },
      ]);
    }
    return;
  }

  if (sub === 'add-member') {
    const agentRef = positional[1];
    if (!agentRef) { console.error('Usage: gitswarm council add-member <agent>'); process.exit(1); }
    const council = await fed.council.getCouncil(repo.id);
    if (!council) { console.error('No council. Run gitswarm council create first.'); process.exit(1); }
    const agent = await fed.resolveAgent(agentRef);
    const member = await fed.council.addMember(council.id, agent.id, flags.role || 'member');
    console.log(`Added ${agent.name} to council as ${member.role}`);
    return;
  }

  if (sub === 'propose') {
    const type = positional[1];
    const title = positional.slice(2).join(' ') || flags.title;
    if (!type || !title || !flags.as) {
      console.error('Usage: gitswarm council propose <type> <title> --as <agent> [--target <agent>]');
      process.exit(1);
    }
    const council = await fed.council.getCouncil(repo.id);
    if (!council) { console.error('No council.'); process.exit(1); }
    const agent = await fed.resolveAgent(flags.as);

    const action_data = {};
    if (flags.target) {
      const target = await fed.resolveAgent(flags.target);
      action_data.agent_id = target.id;
    }
    if (flags.role) action_data.role = flags.role;
    if (flags['access-level']) action_data.access_level = flags['access-level'];
    if (flags.stream) action_data.stream_id = flags.stream;
    if (flags.priority) action_data.priority = parseInt(flags.priority);
    if (flags.tag) action_data.tag = flags.tag;

    const proposal = await fed.council.createProposal(council.id, agent.id, {
      title,
      description: flags.desc || '',
      proposal_type: type,
      action_data,
    });
    console.log(`Proposal created: ${short(proposal.id)}  "${proposal.title}"`);
    console.log(`  type: ${proposal.proposal_type}  quorum: ${proposal.quorum_required}`);
    return;
  }

  if (sub === 'vote') {
    const proposalId = positional[1];
    const vote = positional[2];
    if (!proposalId || !vote || !flags.as) {
      console.error('Usage: gitswarm council vote <proposal-id> for|against|abstain --as <agent>');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'council_proposals', proposalId);
    await fed.council.vote(fullId, agent.id, vote, flags.comment);
    console.log(`Vote '${vote}' recorded.`);
    return;
  }

  if (sub === 'proposals') {
    const council = await fed.council.getCouncil(repo.id);
    if (!council) { console.log('No council.'); return; }
    const proposals = await fed.council.listProposals(council.id, flags.status);
    table(proposals, [
      { label: 'ID',      get: r => short(r.id) },
      { label: 'STATUS',  get: r => r.status },
      { label: 'TYPE',    get: r => r.proposal_type },
      { label: 'TITLE',   get: r => r.title },
      { label: 'VOTES',   get: r => `+${r.votes_for} -${r.votes_against}` },
      { label: 'QUORUM',  get: r => r.quorum_required },
      { label: 'BY',      get: r => r.proposer_name || '—' },
    ]);
    return;
  }

  console.error('Usage: gitswarm council <create|status|add-member|propose|vote|proposals>');
  process.exit(1);
};

// --- status ---
commands.status = async (fed) => {
  const repo = await fed.repo();
  const config = fed.config();
  const agents = await fed.listAgents();

  console.log(`Federation: ${config.name || '(unnamed)'}`);
  console.log(`  path:   ${fed.repoPath}`);
  console.log(`  mode:   ${repo?.merge_mode || config.merge_mode || 'review'}`);
  console.log(`  model:  ${repo?.ownership_model || config.ownership_model}`);
  console.log(`  access: ${repo?.agent_access || config.agent_access}`);
  console.log(`  stage:  ${repo?.stage || 'seed'}`);
  console.log(`  agents: ${agents.length}`);

  if (repo) {
    console.log(`  buffer: ${repo.buffer_branch || 'buffer'} → ${repo.promote_target || 'main'}`);

    const { metrics } = await fed.stages.getMetrics(repo.id);
    console.log(`  contributors: ${metrics.contributor_count}`);
    console.log(`  streams:      ${metrics.patch_count}`);
    console.log(`  maintainers:  ${metrics.maintainer_count}`);
    console.log(`  council:      ${metrics.has_council ? 'yes' : 'no'}`);

    const elig = await fed.stages.checkEligibility(repo.id);
    if (elig.next_stage) {
      console.log(`\n  Next stage: ${elig.next_stage} (${elig.eligible ? 'ELIGIBLE' : 'not yet'})`);
      if (elig.unmet && elig.unmet.length > 0) {
        for (const u of elig.unmet) {
          console.log(`    - ${u.requirement}: ${u.current}/${u.required}`);
        }
      }
    }
  }

  // Streams summary
  try {
    const activeStreams = fed.listActiveStreams();
    const workspaces = await fed.listWorkspaces();
    console.log(`\nStreams: ${activeStreams.length} active`);
    console.log(`Workspaces: ${workspaces.length} active`);

    const queue = fed.tracker.getMergeQueue({ status: 'pending' });
    if (queue.length > 0) {
      console.log(`Merge queue: ${queue.length} pending`);
    }
  } catch {
    // Tracker may not be available
  }

  // Check for Tier 2/3 plugin compatibility
  try {
    const pluginWarnings = fed.checkPluginCompatibility();
    if (pluginWarnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of pluginWarnings) {
        console.log(`  ! ${w}`);
      }
      console.log('  Connect to a server (Mode B) to enable these plugins.');
    }
  } catch {
    // Non-fatal
  }
};

// --- log ---
commands.log = async (fed, { flags }) => {
  const events = await fed.activity.recent({
    limit: flags.limit ? parseInt(flags.limit) : 20,
  });
  if (events.length === 0) { console.log('No activity yet.'); return; }
  for (const e of events) {
    const ts = e.created_at?.slice(0, 19) || '';
    const agent = e.agent_name || short(e.agent_id);
    console.log(`  ${ts}  ${agent}  ${e.event_type}  ${e.target_type || ''}:${short(e.target_id)}`);
  }
};

// --- config ---
commands.config = async (fed, { positional, flags }) => {
  // Pull config from server
  if (flags.pull) {
    const result = await fed.pullConfig();
    if (!result) {
      console.error('Not connected to server. Use gitswarm config --pull after connecting (Mode B).');
      process.exit(1);
    }
    if (result.updated.length === 0) {
      console.log('Config is up to date with server.');
    } else {
      console.log(`Updated ${result.updated.length} fields from server:`);
      for (const field of result.updated) {
        console.log(`  ${field} = ${result.config[field]}`);
      }
    }
    return;
  }

  const config = fed.config();
  if (positional.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (positional.length === 1) {
    console.log(config[positional[0]] ?? '(not set)');
    return;
  }
  const { writeFileSync: write } = await import('fs');
  const { join: joinPath } = await import('path');
  config[positional[0]] = positional[1];
  write(joinPath(fed.swarmDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Set ${positional[0]} = ${positional[1]}`);
};

// --- sync ---
commands.sync = async (fed) => {
  if (!fed.sync) {
    console.error('Not connected to server. Connect with Mode B first.');
    process.exit(1);
  }

  // Push: flush queued events to server
  console.log('Pushing local events to server...');
  try {
    await fed.sync.flushQueue();
    console.log('  Queue flushed.');
  } catch (err) {
    console.error(`  Push failed: ${err.message}`);
  }

  // Pull: poll for server updates
  console.log('Pulling updates from server...');
  const updates = await fed.pollUpdates();
  if (!updates) {
    console.error('  Failed to poll updates.');
    return;
  }

  const counts = [];
  if (updates.tasks?.length > 0) counts.push(`${updates.tasks.length} new tasks`);
  if (updates.access_changes?.length > 0) counts.push(`${updates.access_changes.length} access changes`);
  if (updates.proposals?.length > 0) counts.push(`${updates.proposals.length} proposals`);
  if (updates.reviews?.length > 0) counts.push(`${updates.reviews.length} reviews`);
  if (updates.merges?.length > 0) counts.push(`${updates.merges.length} merges`);
  if (updates.config_changes?.length > 0) counts.push(`${updates.config_changes.length} config changes`);

  if (counts.length === 0) {
    console.log('  Up to date.');
  } else {
    console.log(`  Received: ${counts.join(', ')}`);
  }
};

// ── ID resolution helper ───────────────────────────────────

async function resolveId(fed, tableName, prefix) {
  if (prefix.length >= 32) return prefix;
  const r = await fed.store.query(
    `SELECT id FROM ${tableName} WHERE id LIKE ?`, [`${prefix}%`]
  );
  if (r.rows.length === 0) throw new Error(`No match for ID prefix: ${prefix}`);
  if (r.rows.length > 1) throw new Error(`Ambiguous ID prefix: ${prefix} (${r.rows.length} matches)`);
  return r.rows[0].id;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv);

  if (positional.length === 0 || flags.help) {
    console.log(`gitswarm — local multi-agent federation coordinator

Usage:
  gitswarm <command> [subcommand] [options]

Commands:
  init                   Initialise a federation in the current repo
  agent                  Manage agents (register, list, info)
  workspace              Manage agent workspaces (create, list, destroy)
  commit                 Commit from an agent's workspace
  stream                 Inspect streams (list, info, diff)
  review                 Stream reviews (submit, list, check consensus)
  merge                  Merge a stream to buffer
  stabilize              Run tests and tag green/revert red
  promote                Promote buffer to main
  task                   Task distribution (create, list, claim, submit, review)
  council                Governance (create, status, propose, vote, add-member)
  status                 Show federation status
  log                    View activity log
  config                 View/set federation config

Options:
  --as <agent>           Act as a specific agent (name or ID)
  --help                 Show this help

Examples:
  gitswarm init --name my-project --mode review --model guild
  gitswarm agent register architect --desc "System architect agent"
  gitswarm workspace create --as coder --name "feature/auth"
  gitswarm commit --as coder -m "Add auth module"
  gitswarm review submit abc123 approve --as reviewer --feedback "LGTM"
  gitswarm merge abc123 --as reviewer
  gitswarm stabilize
  gitswarm promote
  gitswarm status`);
    process.exit(0);
  }

  const cmd = positional[0];
  const rest = { positional: positional.slice(1), flags };

  // `init` doesn't require an existing federation
  if (cmd === 'init') {
    commands.init(null, rest);
    return;
  }

  // All other commands need an open federation
  let fed;
  try {
    fed = Federation.open();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  try {
    if (!commands[cmd]) {
      console.error(`Unknown command: ${cmd}.  Run 'gitswarm --help' for usage.`);
      process.exit(1);
    }
    await commands[cmd](fed, rest);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  } finally {
    fed.close();
  }
}

main();
