import type { Agent } from '../../shared/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
    startTime?: bigint;
    requestId?: string;
    humanUser?: {
      id: string;
      role: string;
      github_login?: string;
    };
  }

  // Allow route handlers to access body/params/query without explicit generics
  interface RouteGenericInterface {
    Body?: any;
    Querystring?: any;
    Params?: any;
    Headers?: any;
    Reply?: any;
  }
}
