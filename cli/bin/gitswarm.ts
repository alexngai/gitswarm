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

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

interface TableColumn {
  label: string;
  get: (row: Record<string, unknown>) => unknown;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

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

function table(rows: Record<string, unknown>[], columns: TableColumn[]): void {
  if (rows.length === 0) { console.log('  (none)'); return; }
  const widths = columns.map(c =>
    Math.max(c.label.length, ...rows.map(r => String(c.get(r) ?? '').length))
  );
  const header = columns.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${widths.map(w => '\u2500'.repeat(w)).join('\u2500\u2500')}`);
  for (const row of rows) {
    const line = columns.map((c, i) => String(c.get(row) ?? '').padEnd(widths[i])).join('  ');
    console.log(`  ${line}`);
  }
}

function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '\u2014';
}

function timeAgo(ts: string | number | null | undefined): string {
  if (!ts) return '\u2014';
  const ms = typeof ts === 'number' ? Date.now() - ts : Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Commands ───────────────────────────────────────────────

type CommandFn = (fed: Federation | null, args: ParsedArgs) => void | Promise<void>;

const commands: Record<string, CommandFn> = {};

// --- init ---
commands.init = (_fed: Federation | null, { flags }: ParsedArgs): void => {
  const cwd = resolve(process.cwd());
  try {
    const { config } = Federation.init(cwd, {
      name: flags.name as string | undefined,
      merge_mode: flags.mode as string | undefined,
      ownership_model: flags.model as string | undefined,
      agent_access: flags.access as string | undefined,
      consensus_threshold: flags.threshold ? parseFloat(flags.threshold as string) : undefined,
      min_reviews: flags['min-reviews'] ? parseInt(flags['min-reviews'] as string) : undefined,
      buffer_branch: flags['buffer-branch'] as string | undefined,
      promote_target: flags['promote-target'] as string | undefined,
      stabilize_command: flags['stabilize-command'] as string | undefined,
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
  } catch (e: unknown) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
};

// --- agent ---
commands.agent = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const sub = positional[0];

  if (sub === 'register') {
    const name = positional[1] || (flags.name as string | undefined);
    if (!name) { console.error('Usage: gitswarm agent register <name>'); process.exit(1); }
    const { agent, api_key } = await fed!.registerAgent(name, (flags.desc as string) || '');
    console.log(`Agent registered: ${agent.name}`);
    console.log(`  id:      ${agent.id}`);
    console.log(`  api_key: ${api_key}  (save this — shown only once)`);
    return;
  }

  if (sub === 'list') {
    const agents = await fed!.listAgents();
    table(agents, [
      { label: 'ID',     get: (r: Record<string, unknown>) => short(r.id as string) },
      { label: 'NAME',   get: (r: Record<string, unknown>) => r.name },
      { label: 'KARMA',  get: (r: Record<string, unknown>) => r.karma },
      { label: 'STATUS', get: (r: Record<string, unknown>) => r.status },
      { label: 'CREATED', get: (r: Record<string, unknown>) => (r.created_at as string)?.slice(0, 10) },
    ]);
    return;
  }

  if (sub === 'info') {
    const ref = positional[1];
    if (!ref) { console.error('Usage: gitswarm agent info <name|id>'); process.exit(1); }
    const agent = await fed!.getAgent(ref);
    if (!agent) { console.error(`Agent not found: ${ref}`); process.exit(1); }
    console.log(`Agent: ${agent.name}`);
    console.log(`  id:          ${agent.id}`);
    console.log(`  karma:       ${agent.karma}`);
    console.log(`  status:      ${agent.status}`);
    console.log(`  description: ${agent.description || '\u2014'}`);
    console.log(`  created:     ${agent.created_at}`);
    return;
  }

  console.error('Usage: gitswarm agent <register|list|info>');
  process.exit(1);
};

// --- workspace ---
commands.workspace = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const sub = positional[0];

  if (sub === 'create') {
    if (!flags.as) {
      console.error('Usage: gitswarm workspace create --as <agent> [--name <n>] [--task <id>] [--fork <stream>]');
      process.exit(1);
    }
    const agent = await fed!.resolveAgent(flags.as as string);
    const taskId = flags.task ? await resolveId(fed!, 'tasks', flags.task as string) : undefined;
    const ws = await fed!.createWorkspace({
      agentId: agent.id as string,
      name: flags.name as string | undefined,
      taskId,
      dependsOn: flags.fork as string | undefined,
    });
    console.log(`Workspace created for ${agent.name}`);
    console.log(`  stream: ${ws.streamId}`);
    console.log(`  path:   ${ws.path}`);
    return;
  }

  if (sub === 'list') {
    const workspaces = await fed!.listWorkspaces();
    table(workspaces as unknown as Record<string, unknown>[], [
      { label: 'AGENT',   get: (r: Record<string, unknown>) => r.agentName },
      { label: 'STREAM',  get: (r: Record<string, unknown>) => short(r.streamId as string) },
      { label: 'NAME',    get: (r: Record<string, unknown>) => r.streamName || '\u2014' },
      { label: 'STATUS',  get: (r: Record<string, unknown>) => r.streamStatus || '\u2014' },
      { label: 'ACTIVE',  get: (r: Record<string, unknown>) => timeAgo(r.lastActive as string) },
      { label: 'PATH',    get: (r: Record<string, unknown>) => r.path },
    ]);
    return;
  }

  if (sub === 'destroy') {
    const agentRef = positional[1];
    if (!agentRef) { console.error('Usage: gitswarm workspace destroy <agent> [--abandon]'); process.exit(1); }
    const agent = await fed!.resolveAgent(agentRef);
    await fed!.destroyWorkspace(agent.id as string, { abandonStream: !!flags.abandon });
    console.log(`Workspace destroyed for ${agent.name}`);
    return;
  }

  console.error('Usage: gitswarm workspace <create|list|destroy>');
  process.exit(1);
};

// --- commit ---
commands.commit = async (fed: Federation | null, { flags }: ParsedArgs): Promise<void> => {
  if (!flags.as || !flags.m) {
    console.error('Usage: gitswarm commit --as <agent> -m <message>');
    process.exit(1);
  }
  const agent = await fed!.resolveAgent(flags.as as string);
  const result = await fed!.commit({
    agentId: agent.id as string,
    message: flags.m as string,
    streamId: flags.stream as string | undefined,
  });
  console.log(`Committed: ${result.commit?.slice(0, 8)}`);
  console.log(`  Change-Id: ${result.changeId}`);
  if (result.merged) console.log(`  Auto-merged to buffer (swarm mode)`);
  if (result.conflicts) console.log(`  Merge conflicts: ${result.conflicts.length} files`);
  if (result.mergeError) console.log(`  Merge error: ${result.mergeError}`);
};

// --- stream ---
commands.stream = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const sub = positional[0];

  if (sub === 'list') {
    const streams = fed!._ensureTracker().listStreams({
      status: (flags.status as string) || undefined,
    });
    table(streams, [
      { label: 'ID',      get: (r: Record<string, unknown>) => short(r.id as string) },
      { label: 'NAME',    get: (r: Record<string, unknown>) => r.name },
      { label: 'AGENT',   get: (r: Record<string, unknown>) => short(r.agentId as string) },
      { label: 'STATUS',  get: (r: Record<string, unknown>) => r.status },
      { label: 'PARENT',  get: (r: Record<string, unknown>) => r.parentStream ? short(r.parentStream as string) : '\u2014' },
      { label: 'UPDATED', get: (r: Record<string, unknown>) => timeAgo(r.updatedAt as string) },
    ]);
    return;
  }

  if (sub === 'info') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm stream info <stream-id>'); process.exit(1); }
    const info = fed!.getStreamInfo(streamId);
    if (!info) { console.error(`Stream not found: ${streamId}`); process.exit(1); }
    const { stream, changes, operations, dependencies, children } = info;
    console.log(`Stream: ${stream.name}`);
    console.log(`  id:     ${stream.id}`);
    console.log(`  agent:  ${stream.agentId}`);
    console.log(`  status: ${stream.status}`);
    console.log(`  base:   ${(stream.baseCommit as string)?.slice(0, 8) || '\u2014'}`);
    console.log(`  parent: ${stream.parentStream || '\u2014'}`);
    console.log(`  changes:    ${changes.length}`);
    console.log(`  operations: ${operations.length}`);
    console.log(`  deps:       ${dependencies.length}`);
    console.log(`  children:   ${children.length}`);
    return;
  }

  if (sub === 'diff') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm stream diff <stream-id>'); process.exit(1); }
    const diff = flags.full ? fed!.getStreamDiffFull(streamId) : fed!.getStreamDiff(streamId);
    console.log(diff || '(no changes)');
    return;
  }

  console.error('Usage: gitswarm stream <list|info|diff>');
  process.exit(1);
};

// --- review (stream-based) ---
commands.review = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const sub = positional[0];

  if (sub === 'submit') {
    const streamId = positional[1];
    const verdict = positional[2];
    if (!streamId || !verdict || !flags.as) {
      console.error('Usage: gitswarm review submit <stream-id> approve|request_changes --as <agent> [--feedback <f>]');
      process.exit(1);
    }
    const agent = await fed!.resolveAgent(flags.as as string);
    await fed!.submitReview(streamId, agent.id as string, verdict, (flags.feedback as string) || '', {
      isHuman: !!flags.human,
    });
    console.log(`Review submitted: ${verdict}`);
    return;
  }

  if (sub === 'list') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm review list <stream-id>'); process.exit(1); }
    const reviews = await fed!.getReviews(streamId);
    table(reviews, [
      { label: 'REVIEWER', get: (r: Record<string, unknown>) => r.reviewer_name || short(r.reviewer_id as string) },
      { label: 'VERDICT',  get: (r: Record<string, unknown>) => r.verdict },
      { label: 'HUMAN',    get: (r: Record<string, unknown>) => r.is_human ? 'yes' : 'no' },
      { label: 'FEEDBACK', get: (r: Record<string, unknown>) => ((r.feedback as string) || '').slice(0, 50) },
      { label: 'DATE',     get: (r: Record<string, unknown>) => (r.reviewed_at as string)?.slice(0, 10) },
    ]);
    return;
  }

  if (sub === 'check') {
    const streamId = positional[1];
    if (!streamId) { console.error('Usage: gitswarm review check <stream-id>'); process.exit(1); }
    const result = await fed!.checkConsensus(streamId);
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
commands.merge = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const streamId = positional[0];
  if (!streamId || !flags.as) {
    console.error('Usage: gitswarm merge <stream-id> --as <agent>');
    process.exit(1);
  }
  const agent = await fed!.resolveAgent(flags.as as string);
  const result = await fed!.mergeToBuffer(streamId, agent.id as string);
  console.log(`Merge queued: ${short((result as any).entryId as string)}`);
  if ((result as any).queueResult) {
    const queueResult = (result as any).queueResult;
    console.log(`  processed: ${queueResult.processed || 0}`);
    console.log(`  merged: ${queueResult.merged || 0}`);
  }
};

// --- stabilize ---
commands.stabilize = async (fed: Federation | null): Promise<void> => {
  const result = await fed!.stabilize();
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
commands.promote = async (fed: Federation | null, { flags }: ParsedArgs): Promise<void> => {
  const result = await fed!.promote({ tag: flags.tag as string | undefined });
  console.log(`Promoted: ${result.from} \u2192 ${result.to}`);
};

// --- task ---
commands.task = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const repo = await fed!.repo();
  if (!repo) { console.error('No repo found. Run gitswarm init first.'); process.exit(1); }
  const sub = positional[0];

  if (sub === 'create') {
    const title = positional.slice(1).join(' ') || (flags.title as string | undefined);
    if (!title) { console.error('Usage: gitswarm task create <title> [--as <agent>]'); process.exit(1); }
    const agent = flags.as ? await fed!.resolveAgent(flags.as as string) : null;
    const task = await fed!.tasks.create(repo.id as string, {
      title,
      description: (flags.desc as string) || '',
      priority: (flags.priority as string) || 'medium',
      amount: flags.amount ? parseInt(flags.amount as string) : 0,
      difficulty: (flags.difficulty as string | undefined) || null,
    }, (agent?.id as string) || null);
    console.log(`Task created: ${short(task.id as string)}  ${task.title}`);
    return;
  }

  if (sub === 'list') {
    const tasks = await fed!.tasks.list(repo.id as string, { status: flags.status as string | undefined });
    table(tasks, [
      { label: 'ID',       get: (r: Record<string, unknown>) => short(r.id as string) },
      { label: 'STATUS',   get: (r: Record<string, unknown>) => r.status },
      { label: 'PRIORITY', get: (r: Record<string, unknown>) => r.priority },
      { label: 'TITLE',    get: (r: Record<string, unknown>) => r.title },
      { label: 'CLAIMS',   get: (r: Record<string, unknown>) => r.active_claims || 0 },
      { label: 'CREATOR',  get: (r: Record<string, unknown>) => r.creator_name || '\u2014' },
    ]);
    return;
  }

  if (sub === 'claim') {
    const taskId = positional[1];
    if (!taskId || !flags.as) { console.error('Usage: gitswarm task claim <id> --as <agent>'); process.exit(1); }
    const agent = await fed!.resolveAgent(flags.as as string);
    const fullId = await resolveId(fed!, 'tasks', taskId);
    const claim = await fed!.tasks.claim(fullId, agent.id as string, flags.stream as string | undefined);
    console.log(`Task claimed: ${short(claim.id as string)}`);
    if (claim.stream_id) console.log(`  stream: ${claim.stream_id}`);

    // Mode B: sync task claim to server
    if (fed!.sync) {
      try {
        await fed!.sync.claimTask(repo.id as string, fullId, { streamId: flags.stream as string | undefined });
      } catch {
        fed!.sync._queueEvent({ type: 'task_claim', data: {
          repoId: repo.id, taskId: fullId, streamId: flags.stream,
        }});
      }
    }
    return;
  }

  if (sub === 'submit') {
    const claimId = positional[1];
    if (!claimId || !flags.as) { console.error('Usage: gitswarm task submit <claim-id> --as <agent>'); process.exit(1); }
    const agent = await fed!.resolveAgent(flags.as as string);
    const fullId = await resolveId(fed!, 'task_claims', claimId);
    const result = await fed!.tasks.submit(fullId, agent.id as string, {
      stream_id: flags.stream as string | undefined,
      notes: (flags.notes as string) || '',
    });
    console.log(`Submission recorded: ${short(result.id as string)}`);

    // Mode B: sync task submission to server
    if (fed!.sync) {
      try {
        await fed!.sync.syncTaskSubmission(repo.id as string, result.task_id as string, fullId, {
          streamId: result.stream_id as string | undefined,
          notes: (flags.notes as string) || '',
        });
      } catch {
        fed!.sync._queueEvent({ type: 'task_submission', data: {
          repoId: repo.id, taskId: result.task_id, claimId: fullId,
          streamId: result.stream_id, notes: (flags.notes as string) || '',
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
    const agent = await fed!.resolveAgent(flags.as as string);
    const fullId = await resolveId(fed!, 'task_claims', claimId);
    const result = await fed!.tasks.review(fullId, agent.id as string, decision, flags.notes as string | undefined);
    console.log(`Review: ${result.action}`);
    return;
  }

  console.error('Usage: gitswarm task <create|list|claim|submit|review>');
  process.exit(1);
};

// --- council ---
commands.council = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  const repo = await fed!.repo();
  if (!repo) { console.error('No repo found.'); process.exit(1); }
  const sub = positional[0];

  if (sub === 'create') {
    const council = await fed!.council.create(repo.id as string, {
      min_karma: flags['min-karma'] ? parseInt(flags['min-karma'] as string) : undefined,
      min_contributions: flags['min-contribs'] ? parseInt(flags['min-contribs'] as string) : undefined,
      min_members: flags['min-members'] ? parseInt(flags['min-members'] as string) : undefined,
      max_members: flags['max-members'] ? parseInt(flags['max-members'] as string) : undefined,
      standard_quorum: flags.quorum ? parseInt(flags.quorum as string) : undefined,
      critical_quorum: flags['critical-quorum'] ? parseInt(flags['critical-quorum'] as string) : undefined,
    });
    console.log(`Council created: ${short(council.id as string)}  status: ${council.status}`);
    return;
  }

  if (sub === 'status') {
    const council = await fed!.council.getCouncil(repo.id as string);
    if (!council) { console.log('No council for this repo.'); return; }
    const members = await fed!.council.getMembers(council.id as string);
    const proposals = await fed!.council.listProposals(council.id as string, 'open');
    console.log(`Council: ${council.status}`);
    console.log(`  members: ${members.length}/${council.max_members}  (min: ${council.min_members})`);
    console.log(`  quorum: ${council.standard_quorum} (critical: ${council.critical_quorum})`);
    console.log(`  open proposals: ${proposals.length}`);
    if (members.length > 0) {
      console.log('\nMembers:');
      table(members, [
        { label: 'NAME',  get: (r: Record<string, unknown>) => r.agent_name },
        { label: 'ROLE',  get: (r: Record<string, unknown>) => r.role },
        { label: 'KARMA', get: (r: Record<string, unknown>) => r.karma },
        { label: 'VOTES', get: (r: Record<string, unknown>) => r.votes_cast },
      ]);
    }
    return;
  }

  if (sub === 'add-member') {
    const agentRef = positional[1];
    if (!agentRef) { console.error('Usage: gitswarm council add-member <agent>'); process.exit(1); }
    const council = await fed!.council.getCouncil(repo.id as string);
    if (!council) { console.error('No council. Run gitswarm council create first.'); process.exit(1); }
    const agent = await fed!.resolveAgent(agentRef);
    const member = await fed!.council.addMember(council.id as string, agent.id as string, (flags.role as string) || 'member');
    console.log(`Added ${agent.name} to council as ${member.role}`);
    return;
  }

  if (sub === 'propose') {
    const type = positional[1];
    const title = positional.slice(2).join(' ') || (flags.title as string | undefined);
    if (!type || !title || !flags.as) {
      console.error('Usage: gitswarm council propose <type> <title> --as <agent> [--target <agent>]');
      process.exit(1);
    }
    const council = await fed!.council.getCouncil(repo.id as string);
    if (!council) { console.error('No council.'); process.exit(1); }
    const agent = await fed!.resolveAgent(flags.as as string);

    const action_data: Record<string, unknown> = {};
    if (flags.target) {
      const target = await fed!.resolveAgent(flags.target as string);
      action_data.agent_id = target.id;
    }
    if (flags.role) action_data.role = flags.role;
    if (flags['access-level']) action_data.access_level = flags['access-level'];
    if (flags.stream) action_data.stream_id = flags.stream;
    if (flags.priority) action_data.priority = parseInt(flags.priority as string);
    if (flags.tag) action_data.tag = flags.tag;

    const proposal = await fed!.council.createProposal(council.id as string, agent.id as string, {
      title,
      description: (flags.desc as string) || '',
      proposal_type: type,
      action_data,
    });
    console.log(`Proposal created: ${short(proposal.id as string)}  "${proposal.title}"`);
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
    const agent = await fed!.resolveAgent(flags.as as string);
    const fullId = await resolveId(fed!, 'council_proposals', proposalId);
    await fed!.council.vote(fullId, agent.id as string, vote, flags.comment as string | undefined);
    console.log(`Vote '${vote}' recorded.`);
    return;
  }

  if (sub === 'proposals') {
    const council = await fed!.council.getCouncil(repo.id as string);
    if (!council) { console.log('No council.'); return; }
    const proposals = await fed!.council.listProposals(council.id as string, flags.status as string | undefined);
    table(proposals, [
      { label: 'ID',      get: (r: Record<string, unknown>) => short(r.id as string) },
      { label: 'STATUS',  get: (r: Record<string, unknown>) => r.status },
      { label: 'TYPE',    get: (r: Record<string, unknown>) => r.proposal_type },
      { label: 'TITLE',   get: (r: Record<string, unknown>) => r.title },
      { label: 'VOTES',   get: (r: Record<string, unknown>) => `+${r.votes_for} -${r.votes_against}` },
      { label: 'QUORUM',  get: (r: Record<string, unknown>) => r.quorum_required },
      { label: 'BY',      get: (r: Record<string, unknown>) => r.proposer_name || '\u2014' },
    ]);
    return;
  }

  console.error('Usage: gitswarm council <create|status|add-member|propose|vote|proposals>');
  process.exit(1);
};

// --- status ---
commands.status = async (fed: Federation | null): Promise<void> => {
  const repo = await fed!.repo();
  const config = fed!.config();
  const agents = await fed!.listAgents();

  console.log(`Federation: ${config.name || '(unnamed)'}`);
  console.log(`  path:   ${fed!.repoPath}`);
  console.log(`  mode:   ${repo?.merge_mode || config.merge_mode || 'review'}`);
  console.log(`  model:  ${repo?.ownership_model || config.ownership_model}`);
  console.log(`  access: ${repo?.agent_access || config.agent_access}`);
  console.log(`  stage:  ${repo?.stage || 'seed'}`);
  console.log(`  agents: ${agents.length}`);

  if (repo) {
    console.log(`  buffer: ${repo.buffer_branch || 'buffer'} \u2192 ${repo.promote_target || 'main'}`);

    const { metrics } = await (fed!.stages as any).getMetrics(repo.id as string);
    console.log(`  contributors: ${metrics.contributor_count}`);
    console.log(`  streams:      ${metrics.patch_count}`);
    console.log(`  maintainers:  ${metrics.maintainer_count}`);
    console.log(`  council:      ${metrics.has_council ? 'yes' : 'no'}`);

    const elig = await (fed!.stages as any).checkEligibility(repo.id as string);
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
    const activeStreams = fed!.listActiveStreams();
    const workspaces = await fed!.listWorkspaces();
    console.log(`\nStreams: ${activeStreams.length} active`);
    console.log(`Workspaces: ${workspaces.length} active`);

    const queue = fed!.tracker!.getMergeQueue({ status: 'pending' });
    if (queue.length > 0) {
      console.log(`Merge queue: ${queue.length} pending`);
    }
  } catch {
    // Tracker may not be available
  }

  // Check for Tier 2/3 plugin compatibility
  try {
    const pluginWarnings = fed!.checkPluginCompatibility();
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
commands.log = async (fed: Federation | null, { flags }: ParsedArgs): Promise<void> => {
  const events = await fed!.activity.recent({
    limit: flags.limit ? parseInt(flags.limit as string) : 20,
  });
  if (events.length === 0) { console.log('No activity yet.'); return; }
  for (const e of events) {
    const ts = (e.created_at as string)?.slice(0, 19) || '';
    const agent = (e.agent_name as string) || short(e.agent_id as string);
    console.log(`  ${ts}  ${agent}  ${e.event_type}  ${e.target_type || ''}:${short(e.target_id as string)}`);
  }
};

// --- config ---
commands.config = async (fed: Federation | null, { positional, flags }: ParsedArgs): Promise<void> => {
  // Pull config from server
  if (flags.pull) {
    const result = await fed!.pullConfig();
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

  const config = fed!.config();
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
  write(joinPath(fed!.swarmDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Set ${positional[0]} = ${positional[1]}`);
};

// --- sync ---
commands.sync = async (fed: Federation | null): Promise<void> => {
  if (!fed!.sync) {
    console.error('Not connected to server. Connect with Mode B first.');
    process.exit(1);
  }

  // Push: flush queued events to server
  console.log('Pushing local events to server...');
  try {
    await fed!.sync.flushQueue();
    console.log('  Queue flushed.');
  } catch (err: unknown) {
    console.error(`  Push failed: ${(err as Error).message}`);
  }

  // Pull: poll for server updates
  console.log('Pulling updates from server...');
  const updates = await fed!.pollUpdates();
  if (!updates) {
    console.error('  Failed to poll updates.');
    return;
  }

  const counts: string[] = [];
  if ((updates.tasks as unknown[] | undefined)?.length) counts.push(`${(updates.tasks as unknown[]).length} new tasks`);
  if ((updates.access_changes as unknown[] | undefined)?.length) counts.push(`${(updates.access_changes as unknown[]).length} access changes`);
  if ((updates.proposals as unknown[] | undefined)?.length) counts.push(`${(updates.proposals as unknown[]).length} proposals`);
  if ((updates.reviews as unknown[] | undefined)?.length) counts.push(`${(updates.reviews as unknown[]).length} reviews`);
  if ((updates.merges as unknown[] | undefined)?.length) counts.push(`${(updates.merges as unknown[]).length} merges`);
  if ((updates.config_changes as unknown[] | undefined)?.length) counts.push(`${(updates.config_changes as unknown[]).length} config changes`);

  if (counts.length === 0) {
    console.log('  Up to date.');
  } else {
    console.log(`  Received: ${counts.join(', ')}`);
  }
};

// ── ID resolution helper ───────────────────────────────────

async function resolveId(fed: Federation, tableName: string, prefix: string): Promise<string> {
  if (prefix.length >= 32) return prefix;
  const r = await fed.store.query(
    `SELECT id FROM ${tableName} WHERE id LIKE ?`, [`${prefix}%`]
  );
  if (r.rows.length === 0) throw new Error(`No match for ID prefix: ${prefix}`);
  if (r.rows.length > 1) throw new Error(`Ambiguous ID prefix: ${prefix} (${r.rows.length} matches)`);
  return r.rows[0].id as string;
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv);

  if (positional.length === 0 || flags.help) {
    console.log(`gitswarm \u2014 local multi-agent federation coordinator

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
  const rest: ParsedArgs = { positional: positional.slice(1), flags };

  // `init` doesn't require an existing federation
  if (cmd === 'init') {
    commands.init(null, rest);
    return;
  }

  // All other commands need an open federation
  let fed: Federation;
  try {
    fed = Federation.open();
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(1);
  }

  try {
    if (!commands[cmd]) {
      console.error(`Unknown command: ${cmd}.  Run 'gitswarm --help' for usage.`);
      process.exit(1);
    }
    await commands[cmd](fed, rest);
  } catch (e: unknown) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    fed.close();
  }
}

main();
