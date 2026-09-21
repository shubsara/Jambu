/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Decision D57 — the only value compiled into the bundle. */
  readonly VITE_JAMBU_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
