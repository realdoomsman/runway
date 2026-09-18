import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve the shared package from source so tests never depend on a stale dist build.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@runway/shared': sharedSrc } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
