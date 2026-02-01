// Global test setup
import { beforeAll, afterAll } from 'vitest';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Random port for tests
process.env.HOST = '127.0.0.1';
process.env.API_VERSION = 'v1';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});
