/**
 * Request ID Middleware
 * Generates unique request IDs for tracing and logging
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function requestIdMiddleware(fastify: FastifyInstance, options: Record<string, unknown>, done: (err?: Error) => void): void {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Use existing request ID from header or generate new one
    const requestId: string = (request.headers['x-request-id'] as string) ||
                      `req_${crypto.randomBytes(12).toString('hex')}`;

    // Attach to request object
    (request as unknown as Record<string, unknown>).requestId = requestId;

    // Add to response headers
    reply.header('X-Request-ID', requestId);
  });

  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // Log request completion with timing
    const responseTime: number = reply.elapsedTime;
    request.log.info({
      requestId: (request as unknown as Record<string, unknown>).requestId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: `${responseTime.toFixed(2)}ms`,
    }, 'request completed');
  });

  done();
}

export default requestIdMiddleware;
