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

  isDev: process.env.NODE_ENV !== 'production',
};
