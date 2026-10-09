import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/restore-smoke.acceptance.ts'],
    fileParallelism: false,
  },
});
