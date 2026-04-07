import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const sdkDir = resolve(__dirname, 'node_modules/@multi-agent-protocol/sdk/dist');

export default defineConfig({
  resolve: {
    alias: {
      '@multi-agent-protocol/sdk/server': resolve(sdkDir, 'server.js'),
      '@multi-agent-protocol/sdk/testing': resolve(sdkDir, 'testing.js'),
      '@multi-agent-protocol/sdk': resolve(sdkDir, 'index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
