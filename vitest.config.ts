import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.tsx` too, so React component tests are collected (P12 onboarding).
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
    ],
    environment: 'node',
    sequence: { shuffle: false },
  },
});
