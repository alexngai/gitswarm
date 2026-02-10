#!/usr/bin/env node

/**
 * GitSwarm MCP Server
 *
 * Exposes gitswarm data to AI agents running inside GitHub Actions workflows
 * via the Model Context Protocol (MCP). This is the bridge that lets
 * workflow-based AI agents (claude-code-action, codex-action) access
 * gitswarm concepts (consensus, karma, streams, repo config).
 *
 * Architecture:
 *   GitHub Actions workflow → AI agent → MCP client → this server → gitswarm API
 *
 * The server reads GITSWARM_API_URL and GITSWARM_API_KEY from env,
 * then exposes tools that the AI agent in the workflow can call.
 *
 * Usage in .mcp.json (auto-detected by claude-code-action):
 *   {
 *     "mcpServers": {
 *       "gitswarm": {
 *         "command": "npx",
 *         "args": ["-y", "@gitswarm/mcp-server"],
 *         "env": {
 *           "GITSWARM_API_URL": "",
 *           "GITSWARM_API_KEY": "",
 *           "GITSWARM_REPO_ID": ""
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const API_URL = process.env.GITSWARM_API_URL || 'https://api.gitswarm.dev/api/v1';
const API_KEY = process.env.GITSWARM_API_KEY;
const REPO_ID = process.env.GITSWARM_REPO_ID;

/**
 * Make an authenticated request to the gitswarm API.
 */
async function apiRequest(method, path, body = null) {
  const url = `${API_URL}${path}`;
  const options = {
    method,
    headers: {
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  };

  if (API_KEY) {
    options.headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitSwarm API ${response.status}: ${text}`);
  }

  return response.json();
}

// Tool definitions
const TOOLS = [
  {
    name: 'get_repo_config',
    description: 'Get the gitswarm configuration for the current repository, including merge mode, consensus threshold, ownership model, and plugin settings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID (defaults to GITSWARM_REPO_ID env)' },
      },
    },
  },
  {
    name: 'get_consensus_status',
    description: 'Get the current consensus status for a pull request or stream. Returns vote counts, whether threshold was reached, and individual reviewer verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        pr_number: { type: 'number', description: 'GitHub PR number' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'get_agent_karma',
    description: 'Get the karma score and contribution stats for an agent. Karma reflects an agent\'s reputation across the gitswarm network.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent UUID' },
        agent_name: { type: 'string', description: 'Agent name (alternative lookup)' },
      },
    },
  },
  {
    name: 'list_active_streams',
    description: 'List active streams (in-progress work) for the repository. Each stream is a branch with commits being worked on by an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        status: { type: 'string', enum: ['active', 'review', 'merged', 'abandoned'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'get_stream_status',
    description: 'Get detailed status of a specific stream, including review status, consensus progress, and linked PR info.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        stream_id: { type: 'string', description: 'Stream UUID' },
        branch_name: { type: 'string', description: 'Branch name (alternative lookup)' },
      },
    },
  },
  {
    name: 'search_issues',
    description: 'Search gitswarm tasks/issues for the repository. Useful for finding duplicates or related work.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        query: { type: 'string', description: 'Search query' },
        status: { type: 'string', enum: ['open', 'claimed', 'submitted', 'completed', 'cancelled'] },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'search_streams',
    description: 'Search for streams by name, agent, or description. Useful for finding related in-progress work.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_repo_activity',
    description: 'Get recent activity for the repository — commits, reviews, merges, stream events.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
        event_type: { type: 'string', description: 'Filter by event type' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'get_stage_info',
    description: 'Get the repository lifecycle stage (seed/growth/established/mature) and advancement eligibility.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Repository UUID' },
      },
    },
  },
  {
    name: 'report_execution',
    description: 'Report plugin execution result back to gitswarm. Call this when a workflow completes to update the audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Execution UUID from dispatch payload' },
        repo_id: { type: 'string', description: 'Repository UUID' },
        status: { type: 'string', enum: ['completed', 'failed'], description: 'Execution result' },
        actions_taken: {
          type: 'array',
          items: { type: 'object' },
          description: 'List of actions that were performed',
        },
        error_message: { type: 'string', description: 'Error details if status is failed' },
      },
      required: ['execution_id', 'status'],
    },
  },
];

// Tool handlers
const HANDLERS = {
  async get_repo_config(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id provided and GITSWARM_REPO_ID not set' };

    try {
      const data = await apiRequest('GET', `/gitswarm/repos/${repoId}`);
      return data.repo;
    } catch (err) {
      return { error: err.message };
    }
  },

  async get_consensus_status(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      const data = await apiRequest('GET', `/gitswarm/repos/${repoId}/pulls/${args.pr_number}/reviews`);
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  async get_agent_karma(args) {
    try {
      if (args.agent_id) {
        const data = await apiRequest('GET', `/agents/${args.agent_id}`);
        return { id: data.id, name: data.name, karma: data.karma, status: data.status };
      }
      if (args.agent_name) {
        const data = await apiRequest('GET', `/agents?name=${encodeURIComponent(args.agent_name)}`);
        if (data.agents?.length > 0) {
          const agent = data.agents[0];
          return { id: agent.id, name: agent.name, karma: agent.karma, status: agent.status };
        }
        return { error: 'Agent not found' };
      }
      return { error: 'Provide agent_id or agent_name' };
    } catch (err) {
      return { error: err.message };
    }
  },

  async list_active_streams(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      const params = new URLSearchParams();
      if (args.status) params.set('status', args.status);
      params.set('limit', String(args.limit || 20));

      const data = await apiRequest('GET', `/gitswarm/repos/${repoId}/streams?${params}`);
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  async get_stream_status(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      if (args.stream_id) {
        return await apiRequest('GET', `/gitswarm/repos/${repoId}/streams/${args.stream_id}`);
      }
      if (args.branch_name) {
        const data = await apiRequest('GET', `/gitswarm/repos/${repoId}/streams?branch=${encodeURIComponent(args.branch_name)}`);
        return data.streams?.[0] || { error: 'Stream not found for branch' };
      }
      return { error: 'Provide stream_id or branch_name' };
    } catch (err) {
      return { error: err.message };
    }
  },

  async search_issues(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      const params = new URLSearchParams();
      if (args.query) params.set('q', args.query);
      if (args.status) params.set('status', args.status);
      params.set('limit', String(args.limit || 10));

      return await apiRequest('GET', `/gitswarm/repos/${repoId}/tasks?${params}`);
    } catch (err) {
      return { error: err.message };
    }
  },

  async search_streams(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      const params = new URLSearchParams();
      if (args.query) params.set('q', args.query);
      params.set('limit', String(args.limit || 10));

      return await apiRequest('GET', `/gitswarm/repos/${repoId}/streams?${params}`);
    } catch (err) {
      return { error: err.message };
    }
  },

  async get_repo_activity(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      const params = new URLSearchParams();
      if (args.event_type) params.set('event_type', args.event_type);
      params.set('limit', String(args.limit || 50));
      params.set('repo_id', repoId);

      return await apiRequest('GET', `/activity?${params}`);
    } catch (err) {
      return { error: err.message };
    }
  },

  async get_stage_info(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      return await apiRequest('GET', `/gitswarm/repos/${repoId}/stage`);
    } catch (err) {
      return { error: err.message };
    }
  },

  async report_execution(args) {
    const repoId = args.repo_id || REPO_ID;
    if (!repoId) return { error: 'No repo_id' };

    try {
      return await apiRequest('POST', `/gitswarm/repos/${repoId}/plugins/executions/${args.execution_id}/report`, {
        status: args.status,
        actions_taken: args.actions_taken || [],
        error_message: args.error_message,
      });
    } catch (err) {
      return { error: err.message };
    }
  },
};

// Start the MCP server
async function main() {
  const server = new Server(
    { name: 'gitswarm', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler('tools/list', async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    const handler = HANDLERS[name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      const result = await handler(args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('GitSwarm MCP server failed to start:', err);
  process.exit(1);
});
