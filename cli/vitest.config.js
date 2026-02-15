import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Redirect missing git-cascade peer dependency to our in-memory mock
// so integration/e2e tests can exercise the full Federation lifecycle.
function mockGitCascade() {
  const mockPath = resolve(import.meta.dirname, 'test/git-cascade-mock.ts');
  return {
    name: 'mock-git-cascade',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'git-cascade') return mockPath;
      // Vite generates __vite-optional-peer-dep:<pkg>:<importer> for missing optional peers
      if (id.startsWith('__vite-optional-peer-dep:')) {
        const pkg = id.split(':')[1];
        if (pkg === 'git-cascade') return mockPath;
      }
    },
  };
}

export default defineConfig({
  plugins: [mockGitCascade()],
  resolve: {
    conditions: ['node'],
  },
  test: {
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    include: ['test/**/*.test.ts'],
  },
});
