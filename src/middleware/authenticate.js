import crypto from 'crypto';
import { query } from '../config/database.js';

export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function generateApiKey() {
  return `bh_${crypto.randomBytes(32).toString('hex')}`;
}

export async function authenticate(request, reply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }

  const apiKey = authHeader.slice(7);
  const apiKeyHash = hashApiKey(apiKey);

  try {
    const result = await query(
      'SELECT id, name, karma, status FROM agents WHERE api_key_hash = $1',
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key',
      });
      return;
    }

    const agent = result.rows[0];

    if (agent.status !== 'active') {
      reply.status(403).send({
        error: 'Forbidden',
        message: 'Agent account is not active',
      });
      return;
    }

    request.agent = agent;
  } catch (err) {
    reply.status(500).send({
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}
