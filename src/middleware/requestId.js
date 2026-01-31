/**
 * Request ID Middleware
 * Generates unique request IDs for tracing and logging
 */

import crypto from 'crypto';

export function requestIdMiddleware(fastify, options, done) {
  fastify.addHook('onRequest', async (request, reply) => {
    // Use existing request ID from header or generate new one
    const requestId = request.headers['x-request-id'] ||
                      `req_${crypto.randomBytes(12).toString('hex')}`;

    // Attach to request object
    request.requestId = requestId;

    // Add to response headers
    reply.header('X-Request-ID', requestId);
  });

  fastify.addHook('onResponse', async (request, reply) => {
    // Log request completion with timing
    const responseTime = reply.elapsedTime;
    request.log.info({
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: `${responseTime.toFixed(2)}ms`,
    }, 'request completed');
  });

  done();
}

export default requestIdMiddleware;
