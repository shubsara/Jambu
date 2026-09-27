import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Plain Vite with a hand-written manifest (decision D52).
 *
 * No CRX plugin: the manifest is the file whose contents we most want to
 * control and review, and a snapshot test asserts its permissions. It lives in
 * `public/` so Vite copies it to the build output verbatim.
 *
 * Only `VITE_JAMBU_API_BASE_URL` is compiled in (decision D57). Anything
 * prefixed `VITE_` is public by definition, so no Supabase URL or key may ever
 * be given that prefix.
 */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  // Vite resolves `.env` against `root`, which here is `src/` — so the
  // repo-root `.env` that `.env.example` documents was never being read, and
  // `VITE_JAMBU_API_BASE_URL` silently had no effect from that file. Point it
  // at the workspace root so the documented pattern actually works.
  envDir: resolve(__dirname, '../..'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Readable output, so the bundle secret scan inspects something a human
    // could also check by eye.
    minify: false,
    rollupOptions: {
      input: {
        'popup/index': resolve(__dirname, 'src/popup/index.html'),
        // Decision D85: onboarding is its own page, opened with
        // `chrome.tabs.create`, which needs no extra permission.
        'onboarding/index': resolve(__dirname, 'src/onboarding/index.html'),
        // Decision D97: settings is its own options page, reached with
        // `chrome.runtime.openOptionsPage()`.
        'options/index': resolve(__dirname, 'src/options/index.html'),
        'background/service-worker': resolve(
          __dirname,
          'src/background/service-worker.ts',
        ),
        // Injected on demand by the orchestrator, never a static content
        // script (decision D3).
        'content/care-card': resolve(__dirname, 'src/content/care-card/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
