/**
 * OAuth Routes for Human Dashboard Authentication
 * Supports GitHub and Google OAuth providers
 */

import crypto from 'crypto';

// In-memory session store (use Redis in production)
const sessions = new Map();

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

export default async function authRoutes(fastify, options) {
  const { db } = options;

  // GitHub OAuth configuration
  const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/callback/github';

  // Google OAuth configuration
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/callback/google';

  /**
   * GET /auth/github
   * Initiate GitHub OAuth flow
   */
  fastify.get('/auth/github', async (request, reply) => {
    if (!GITHUB_CLIENT_ID) {
      return reply.status(500).send({ error: 'GitHub OAuth not configured' });
    }

    const state = crypto.randomBytes(16).toString('hex');

    // Store state for CSRF protection
    sessions.set(`oauth_state_${state}`, { created: Date.now() });

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_CALLBACK_URL,
      scope: 'read:user user:email',
      state,
    });

    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  /**
   * GET /auth/callback/github
   * Handle GitHub OAuth callback
   */
  fastify.get('/auth/callback/github', async (request, reply) => {
    const { code, state } = request.query;

    if (!code || !state) {
      return reply.status(400).send({ error: 'Missing code or state' });
    }

    // Verify state for CSRF protection
    const storedState = sessions.get(`oauth_state_${state}`);
    if (!storedState) {
      return reply.status(400).send({ error: 'Invalid state' });
    }
    sessions.delete(`oauth_state_${state}`);

    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: GITHUB_CALLBACK_URL,
        }),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.error) {
        return reply.status(400).send({ error: tokenData.error_description || 'OAuth failed' });
      }

      // Get user info from GitHub
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Accept': 'application/json',
        },
      });

      const githubUser = await userResponse.json();

      // Get user email (may be private)
      let email = githubUser.email;
      if (!email) {
        const emailsResponse = await fetch('https://api.github.com/user/emails', {
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Accept': 'application/json',
          },
        });
        const emails = await emailsResponse.json();
        const primaryEmail = emails.find(e => e.primary);
        email = primaryEmail?.email || emails[0]?.email;
      }

      // Create or update human user in database
      let user;
      if (db) {
        const result = await db.query(`
          INSERT INTO human_users (email, name, avatar_url, oauth_provider, oauth_id)
          VALUES ($1, $2, $3, 'github', $4)
          ON CONFLICT (email) DO UPDATE SET
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            oauth_id = EXCLUDED.oauth_id,
            updated_at = NOW()
          RETURNING id, email, name, avatar_url, role
        `, [email, githubUser.name || githubUser.login, githubUser.avatar_url, String(githubUser.id)]);

        user = result.rows[0];
      } else {
        // Mock user for development
        user = {
          id: 'mock_user_1',
          email,
          name: githubUser.name || githubUser.login,
          avatar_url: githubUser.avatar_url,
          role: 'viewer',
        };
      }

      // Create session
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        user,
        created: Date.now(),
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      // Set session cookie
      reply.setCookie('bothub_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
      });

      // Redirect to dashboard
      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      return reply.redirect(dashboardUrl);

    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  /**
   * GET /auth/google
   * Initiate Google OAuth flow
   */
  fastify.get('/auth/google', async (request, reply) => {
    if (!GOOGLE_CLIENT_ID) {
      return reply.status(500).send({ error: 'Google OAuth not configured' });
    }

    const state = crypto.randomBytes(16).toString('hex');

    // Store state for CSRF protection
    sessions.set(`oauth_state_${state}`, { created: Date.now() });

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  /**
   * GET /auth/callback/google
   * Handle Google OAuth callback
   */
  fastify.get('/auth/callback/google', async (request, reply) => {
    const { code, state, error: oauthError } = request.query;

    if (oauthError) {
      return reply.status(400).send({ error: oauthError });
    }

    if (!code || !state) {
      return reply.status(400).send({ error: 'Missing code or state' });
    }

    // Verify state for CSRF protection
    const storedState = sessions.get(`oauth_state_${state}`);
    if (!storedState) {
      return reply.status(400).send({ error: 'Invalid state' });
    }
    sessions.delete(`oauth_state_${state}`);

    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          redirect_uri: GOOGLE_CALLBACK_URL,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.error) {
        return reply.status(400).send({ error: tokenData.error_description || 'OAuth failed' });
      }

      // Get user info from Google
      const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
      });

      const googleUser = await userResponse.json();

      if (!googleUser.email) {
        return reply.status(400).send({ error: 'Email not available from Google' });
      }

      // Create or update human user in database
      let user;
      if (db) {
        const result = await db.query(`
          INSERT INTO human_users (email, name, avatar_url, oauth_provider, oauth_id)
          VALUES ($1, $2, $3, 'google', $4)
          ON CONFLICT (email) DO UPDATE SET
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            oauth_id = EXCLUDED.oauth_id,
            updated_at = NOW()
          RETURNING id, email, name, avatar_url, role
        `, [googleUser.email, googleUser.name, googleUser.picture, String(googleUser.id)]);

        user = result.rows[0];
      } else {
        // Mock user for development
        user = {
          id: 'mock_user_1',
          email: googleUser.email,
          name: googleUser.name,
          avatar_url: googleUser.picture,
          role: 'viewer',
        };
      }

      // Create session
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        user,
        created: Date.now(),
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      // Set session cookie
      reply.setCookie('bothub_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
      });

      // Redirect to dashboard
      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      return reply.redirect(dashboardUrl);

    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  /**
   * GET /auth/me
   * Get current authenticated user
   */
  fastify.get('/auth/me', async (request, reply) => {
    const sessionId = request.cookies?.bothub_session;

    if (!sessionId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const session = sessions.get(sessionId);

    if (!session || session.expires < Date.now()) {
      sessions.delete(sessionId);
      return reply.status(401).send({ error: 'Session expired' });
    }

    return { user: session.user };
  });

  /**
   * POST /auth/logout
   * Logout and clear session
   */
  fastify.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies?.bothub_session;

    if (sessionId) {
      sessions.delete(sessionId);
    }

    reply.clearCookie('bothub_session', { path: '/' });
    return { success: true };
  });

  /**
   * Middleware to check if user is authenticated
   */
  fastify.decorate('authenticateHuman', async function(request, reply) {
    const sessionId = request.cookies?.bothub_session;

    if (!sessionId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const session = sessions.get(sessionId);

    if (!session || session.expires < Date.now()) {
      sessions.delete(sessionId);
      return reply.status(401).send({ error: 'Session expired' });
    }

    request.humanUser = session.user;
  });

  /**
   * Middleware to check if user is admin
   */
  fastify.decorate('requireAdmin', async function(request, reply) {
    await fastify.authenticateHuman(request, reply);

    if (request.humanUser?.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  });
}

// Export session store for cleanup
export { sessions };
