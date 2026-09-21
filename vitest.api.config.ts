import { defineConfig } from 'vitest/config';

/**
 * Live API integration tests (decision D20).
 *
 * These drive the real Fastify app against the running local Supabase stack,
 * so they are kept out of `pnpm test` and `pnpm verify` — the same treatment
 * the database tests get, and for the same reason: CI has no Docker.
 *
 * Run with `pnpm test:api` after `pnpm db:start`.
 */
export default defineConfig({
  test: {
    include: ['apps/api/tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
