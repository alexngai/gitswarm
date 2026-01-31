import 'dotenv/config';

export const config = {
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

  isDev: process.env.NODE_ENV !== 'production',
};
