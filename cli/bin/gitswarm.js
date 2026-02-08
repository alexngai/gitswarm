#!/usr/bin/env node

/**
 * gitswarm — standalone CLI for local multi-agent federation coordination.
 *
 * Usage:
 *   gitswarm init [--name <name>] [--model solo|guild|open]
 *   gitswarm agent register <name> [--desc <description>]
 *   gitswarm agent list
 *   gitswarm agent info <name|id>
 *   gitswarm task create <title> [--desc <d>] [--priority <p>] [--as <agent>]
 *   gitswarm task list [--status <s>]
 *   gitswarm task claim <id> --as <agent>
 *   gitswarm task submit <claim-id> --as <agent> [--notes <n>]
 *   gitswarm task review <claim-id> approve|reject --as <agent> [--notes <n>]
 *   gitswarm patch create <title> --branch <b> --as <agent>
 *   gitswarm patch list [--status <s>]
 *   gitswarm review submit <patch-id> approve|request_changes --as <agent> [--feedback <f>]
 *   gitswarm review check <patch-id>
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
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Flags that are boolean (no value)
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

// ── Commands ───────────────────────────────────────────────

const commands = {};

// --- init ---
commands.init = (_fed, { flags }) => {
  const cwd = resolve(process.cwd());
  try {
    const { config } = Federation.init(cwd, {
      name: flags.name,
      ownership_model: flags.model,
      agent_access: flags.access,
      consensus_threshold: flags.threshold ? parseFloat(flags.threshold) : undefined,
      min_reviews: flags['min-reviews'] ? parseInt(flags['min-reviews']) : undefined,
    });
    console.log(`Initialised gitswarm federation: ${config.name}`);
    console.log(`  model: ${config.ownership_model}`);
    console.log(`  access: ${config.agent_access}`);
    console.log(`  consensus: ${config.consensus_threshold}`);
    console.log(`  store: .gitswarm/federation.db`);
    console.log('\nNext steps:');
    console.log('  gitswarm agent register <name>   Register an agent');
    console.log('  gitswarm task create <title>      Create a task');
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
    const claim = await fed.tasks.claim(fullId, agent.id);
    console.log(`Task claimed: ${short(claim.id)}`);
    return;
  }

  if (sub === 'submit') {
    const claimId = positional[1];
    if (!claimId || !flags.as) { console.error('Usage: gitswarm task submit <claim-id> --as <agent>'); process.exit(1); }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'task_claims', claimId);
    const result = await fed.tasks.submit(fullId, agent.id, { notes: flags.notes || '' });
    console.log(`Submission recorded: ${short(result.id)}`);
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

// --- patch ---
commands.patch = async (fed, { positional, flags }) => {
  const repo = await fed.repo();
  if (!repo) { console.error('No repo found.'); process.exit(1); }
  const sub = positional[0];

  if (sub === 'create') {
    const title = positional.slice(1).join(' ') || flags.title;
    if (!title || !flags.as) {
      console.error('Usage: gitswarm patch create <title> --as <agent> [--branch <b>]');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    const branch = flags.branch || fed.git.currentBranch();
    const patch = await fed.createPatch(repo.id, agent.id, {
      title,
      description: flags.desc || '',
      source_branch: branch,
      target_branch: flags.target || 'main',
    });
    console.log(`Patch created: ${short(patch.id)}  ${patch.title}`);
    console.log(`  branch: ${patch.source_branch} → ${patch.target_branch}`);
    return;
  }

  if (sub === 'list') {
    const patches = await fed.listPatches(repo.id, flags.status);
    table(patches, [
      { label: 'ID',      get: r => short(r.id) },
      { label: 'STATUS',  get: r => r.status },
      { label: 'TITLE',   get: r => r.title },
      { label: 'BRANCH',  get: r => `${r.source_branch} → ${r.target_branch}` },
      { label: 'AUTHOR',  get: r => r.author_name || '—' },
    ]);
    return;
  }

  console.error('Usage: gitswarm patch <create|list>');
  process.exit(1);
};

// --- review ---
commands.review = async (fed, { positional, flags }) => {
  const sub = positional[0];

  if (sub === 'submit') {
    const patchId = positional[1];
    const verdict = positional[2];
    if (!patchId || !verdict || !flags.as) {
      console.error('Usage: gitswarm review submit <patch-id> approve|request_changes --as <agent>');
      process.exit(1);
    }
    const agent = await fed.resolveAgent(flags.as);
    const fullId = await resolveId(fed, 'patches', patchId);
    const review = await fed.submitReview(fullId, agent.id, verdict, flags.feedback || '');
    console.log(`Review submitted: ${verdict}`);
    return;
  }

  if (sub === 'list') {
    const patchId = positional[1];
    if (!patchId) { console.error('Usage: gitswarm review list <patch-id>'); process.exit(1); }
    const fullId = await resolveId(fed, 'patches', patchId);
    const reviews = await fed.getReviews(fullId);
    table(reviews, [
      { label: 'REVIEWER', get: r => r.reviewer_name || short(r.reviewer_id) },
      { label: 'VERDICT',  get: r => r.verdict },
      { label: 'FEEDBACK', get: r => (r.feedback || '').slice(0, 50) },
      { label: 'DATE',     get: r => r.reviewed_at?.slice(0, 10) },
    ]);
    return;
  }

  if (sub === 'check') {
    const patchId = positional[1];
    if (!patchId) { console.error('Usage: gitswarm review check <patch-id>'); process.exit(1); }
    const repo = await fed.repo();
    const fullId = await resolveId(fed, 'patches', patchId);
    const result = await fed.permissions.checkConsensus(fullId, repo.id);
    console.log(`Consensus: ${result.reached ? 'REACHED' : 'NOT REACHED'}`);
    console.log(`  reason: ${result.reason}`);
    if (result.ratio !== undefined) console.log(`  ratio:  ${result.ratio} (threshold: ${result.threshold})`);
    if (result.approvals !== undefined) console.log(`  approvals: ${result.approvals}  rejections: ${result.rejections}`);
    return;
  }

  console.error('Usage: gitswarm review <submit|list|check>');
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
      console.error('Usage: gitswarm council propose <type> <title> --as <agent> [--target <agent>] [--access-level <level>]');
      process.exit(1);
    }
    const council = await fed.council.getCouncil(repo.id);
    if (!council) { console.error('No council.'); process.exit(1); }
    const agent = await fed.resolveAgent(flags.as);

    // Build action_data from flags
    const action_data = {};
    if (flags.target) {
      const target = await fed.resolveAgent(flags.target);
      action_data.agent_id = target.id;
    }
    if (flags.role) action_data.role = flags.role;
    if (flags['access-level']) action_data.access_level = flags['access-level'];

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
  console.log(`  model:  ${repo?.ownership_model || config.ownership_model}`);
  console.log(`  access: ${repo?.agent_access || config.agent_access}`);
  console.log(`  stage:  ${repo?.stage || 'seed'}`);
  console.log(`  agents: ${agents.length}`);

  if (repo) {
    const { metrics } = await fed.stages.getMetrics(repo.id);
    console.log(`  contributors: ${metrics.contributor_count}`);
    console.log(`  patches:      ${metrics.patch_count}`);
    console.log(`  maintainers:  ${metrics.maintainer_count}`);
    console.log(`  council:      ${metrics.has_council ? 'yes' : 'no'}`);

    // Stage eligibility
    const elig = await fed.stages.checkEligibility(repo.id);
    if (elig.next_stage) {
      console.log(`\n  Next stage: ${elig.next_stage} (${elig.eligible ? 'ELIGIBLE' : 'not yet'})`);
      if (elig.unmet && elig.unmet.length > 0) {
        for (const u of elig.unmet) {
          console.log(`    ✗ ${u.requirement}: ${u.current}/${u.required}`);
        }
      }
    }
  }

  // Git info
  if (fed.git.isRepo()) {
    console.log(`\nGit:`);
    try { console.log(`  branch: ${fed.git.currentBranch()}`); } catch { /* empty repo */ }
    try { console.log(`  dirty:  ${fed.git.isDirty() ? 'yes' : 'no'}`); } catch { /* empty repo */ }
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
commands.config = async (fed, { positional }) => {
  const config = fed.config();
  if (positional.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (positional.length === 1) {
    console.log(config[positional[0]] ?? '(not set)');
    return;
  }
  // set
  const { writeFileSync: write } = await import('fs');
  const { join: joinPath } = await import('path');
  config[positional[0]] = positional[1];
  write(joinPath(fed.swarmDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Set ${positional[0]} = ${positional[1]}`);
};

// ── ID resolution helper ───────────────────────────────────

async function resolveId(fed, table, prefix) {
  // Allow short IDs (prefix match)
  if (prefix.length >= 32) return prefix;
  const r = await fed.store.query(
    `SELECT id FROM ${table} WHERE id LIKE ?`, [`${prefix}%`]
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
  task                   Task distribution (create, list, claim, submit, review)
  patch                  Code patches (create, list)
  review                 Patch reviews (submit, list, check consensus)
  council                Governance (create, status, propose, vote, add-member)
  status                 Show federation status
  log                    View activity log
  config                 View/set federation config

Options:
  --as <agent>           Act as a specific agent (name or ID)
  --help                 Show this help

Examples:
  gitswarm init --name my-project --model guild
  gitswarm agent register architect --desc "System architect agent"
  gitswarm task create "Implement auth module" --priority high --as architect
  gitswarm task claim a1b2c3d4 --as coder
  gitswarm review submit f0e1d2c3 approve --as reviewer --feedback "LGTM"
  gitswarm council create --quorum 2
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
