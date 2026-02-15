// Global test setup
import { beforeAll, afterAll } from 'vitest';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Random port for tests
process.env.HOST = '127.0.0.1';
process.env.API_VERSION = 'v1';

beforeAll((): void => {
  // Global setup before all tests
});

afterAll((): void => {
  // Global cleanup after all tests
});
