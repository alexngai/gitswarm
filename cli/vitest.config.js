import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Prevent Vite from trying to transform native modules
    conditions: ['node'],
  },
  ssr: {
    // Mark native/binary modules as external (not bundled by Vite)
    external: ['git-cascade', 'better-sqlite3'],
  },
  test: {
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    include: ['test/**/*.test.js'],
  },
});
