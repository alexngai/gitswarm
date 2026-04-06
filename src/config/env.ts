import 'dotenv/config';

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  api: {
    version: string;
  };
  github: {
    appId: string | undefined;
    privateKey: string | undefined;
    webhookSecret: string | undefined;
    clientId: string | undefined;
    clientSecret: string | undefined;
  };
  gitea: {
    url: string | undefined;
    adminToken: string | undefined;
    internalSecret: string | undefined;
    sshUrl: string | undefined;
    externalUrl: string | undefined;
  };
  defaultGitBackend: 'github' | 'gitea' | 'cascade';
  openhive: {
    url: string | undefined;
    apiKey: string | undefined;
    syncEnabled: boolean;
    syncIntervalMs: number;
  };
  isDev: boolean;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/bothub',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  api: {
    version: process.env.API_VERSION || 'v1',
  },

  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },

  gitea: {
    url: process.env.GITEA_URL,
    adminToken: process.env.GITEA_ADMIN_TOKEN,
    internalSecret: process.env.GITEA_INTERNAL_SECRET,
    sshUrl: process.env.GITEA_SSH_URL,
    externalUrl: process.env.GITEA_EXTERNAL_URL,
  },

  defaultGitBackend: (process.env.DEFAULT_GIT_BACKEND as 'github' | 'gitea' | 'cascade') ||
    (process.env.GITEA_URL ? 'gitea' : 'github'),

  openhive: {
    url: process.env.OPENHIVE_URL,
    apiKey: process.env.OPENHIVE_API_KEY,
    syncEnabled: !!process.env.OPENHIVE_URL,
    syncIntervalMs: parseInt(process.env.OPENHIVE_SYNC_INTERVAL_MS || '30000', 10),
  },

  isDev: process.env.NODE_ENV !== 'production',
};
