/**
 * GitHub-Compatible Repository Dispatches
 *
 * POST /repos/:owner/:repo/dispatches → fires a plugin engine event.
 * Used by CI tools and bots that trigger workflows via repository_dispatch.
 */
import type { FastifyInstance } from 'fastify';
import { githubCompatAuth, resolveRepoFromParams } from './index.js';

export async function dispatchRoutes(app: FastifyInstance, options: Record<string, any> = {}): Promise<void> {
  const { pluginEngine } = options;

  /**
   * POST /repos/:owner/:repo/dispatches
   * Triggers a repository_dispatch event through the plugin engine.
   */
  app.post('/repos/:owner/:repo/dispatches', {
    preHandler: [githubCompatAuth],
  }, async (request, reply) => {
    const { owner, repo: repoName } = request.params as { owner: string; repo: string };
    const { event_type, client_payload } = request.body as { event_type: string; client_payload?: Record<string, any> };

    if (!event_type) {
      return reply.status(422).send({ message: 'event_type is required' });
    }

    const repoRecord = await resolveRepoFromParams(owner, repoName);
    if (!repoRecord) {
      return reply.status(404).send({ message: 'Not Found' });
    }

    // Fire through plugin engine if available
    if (pluginEngine) {
      pluginEngine.processGitswarmEvent(repoRecord.id, `repository_dispatch.${event_type}`, {
        event_type,
        client_payload: client_payload || {},
        sender: (request as any).agent,
      }).catch((err: any) => {
        app.log.error({ error: err.message }, 'Dispatch plugin error');
      });
    }

    // GitHub returns 204 for dispatches
    return reply.status(204).send();
  });
}
