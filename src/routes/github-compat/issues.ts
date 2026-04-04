/**
 * GitHub-Compatible Issues Endpoints
 *
 * Issues = GitSwarm Tasks.
 *
 * GET  /repos/:owner/:repo/issues      — list tasks as issues
 * POST /repos/:owner/:repo/issues      — create task
 * GET  /repos/:owner/:repo/issues/:number — get task by task_number
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../../config/database.js';
import { githubCompatAuth, resolveRepoFromParams } from './index.js';

export async function issuesRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /repos/:owner/:repo/issues
   */
  app.get('/repos/:owner/:repo/issues', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { state = 'open', per_page = 30, page = 1, labels } = request.query as Record<string, any>;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    let statusFilter: string[];
    switch (state) {
      case 'open': statusFilter = ['open', 'claimed']; break;
      case 'closed': statusFilter = ['completed', 'cancelled']; break;
      case 'all': statusFilter = ['open', 'claimed', 'submitted', 'completed', 'cancelled']; break;
      default: statusFilter = ['open', 'claimed'];
    }

    const limit = Math.min(parseInt(per_page) || 30, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const tasks = await query(`
      SELECT t.*, a.name as creator_name, a.avatar_url as creator_avatar
      FROM gitswarm_tasks t
      LEFT JOIN agents a ON t.created_by = a.id
      WHERE t.repo_id = $1 AND t.status = ANY($2)
      ORDER BY t.created_at DESC
      LIMIT $3 OFFSET $4
    `, [repoRecord.id, statusFilter, limit, offset]);

    return tasks.rows.map(t => formatIssueResponse(t, owner, repoName));
  });

  /**
   * POST /repos/:owner/:repo/issues
   */
  app.post('/repos/:owner/:repo/issues', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { title, body, labels } = request.body as { title: string; body?: string; labels?: string[] };
    const agent = (request as any).agent;

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const result = await query(`
      INSERT INTO gitswarm_tasks (repo_id, title, description, created_by, labels, status)
      VALUES ($1, $2, $3, $4, $5, 'open')
      RETURNING *
    `, [repoRecord.id, title, body || '', agent.id, JSON.stringify(labels || [])]);

    const task = result.rows[0];

    reply.status(201);
    return formatIssueResponse({
      ...task,
      creator_name: agent.name,
      creator_avatar: null,
    }, owner, repoName);
  });

  /**
   * GET /repos/:owner/:repo/issues/:number
   */
  app.get('/repos/:owner/:repo/issues/:number', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName, number: issueNumber } = request.params as { owner: string; repo: string; number: string };

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    const task = await query(`
      SELECT t.*, a.name as creator_name, a.avatar_url as creator_avatar
      FROM gitswarm_tasks t
      LEFT JOIN agents a ON t.created_by = a.id
      WHERE t.repo_id = $1 AND t.task_number = $2
    `, [repoRecord.id, parseInt(issueNumber)]);

    if (task.rows.length === 0) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    return formatIssueResponse(task.rows[0], owner, repoName);
  });
}

function formatIssueResponse(task: Record<string, any>, owner: string, repoName: string) {
  const isOpen = ['open', 'claimed', 'submitted'].includes(task.status);
  return {
    number: task.task_number,
    state: isOpen ? 'open' : 'closed',
    title: task.title,
    body: task.description || '',
    labels: (task.labels || []).map((l: string) => ({ name: l })),
    user: {
      login: task.creator_name || 'unknown',
      id: task.created_by,
      avatar_url: task.creator_avatar,
      type: 'Bot',
    },
    created_at: task.created_at,
    updated_at: task.updated_at,
    closed_at: task.completed_at,
    html_url: `${owner}/${repoName}/issues/${task.task_number}`,
    // GitSwarm extensions
    gitswarm_task_id: task.id,
    gitswarm_status: task.status,
    gitswarm_priority: task.priority,
    gitswarm_amount: task.amount,
    gitswarm_difficulty: task.difficulty,
  };
}
