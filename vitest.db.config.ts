import { defineConfig } from 'vitest/config';

/**
 * Database tests. Separate from vitest.config.ts because these need a running
 * PostgreSQL server (the local Supabase stack, decision D11), whereas
 * `pnpm test` must stay runnable — and CI must stay green — without Docker.
 *
 * Run with `pnpm test:db` after `pnpm db:start`.
 */
export default defineConfig({
  test: {
    include: ['database/tests/**/*.test.ts'],
    environment: 'node',
    // The suites share one database; running them in parallel would let one
    // file's fixtures appear in another's assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
