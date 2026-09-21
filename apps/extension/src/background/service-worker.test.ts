/**
 * Service-worker restart safety (CLAUDE.md §10, MV3 lifecycle).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installFakeChrome,
  simulateBrowserRestart,
  simulateWorkerRestart,
  uninstallFakeChrome,
  type FakeAreas,
} from '../lib/chrome-fake.test-helpers.js';
import { saveSession } from '../lib/storage.js';
import { registerListeners, resolveAuthState } from './service-worker.js';

let areas: FakeAreas;

const SESSION = {
  accessToken: 'access-token-value',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshToken: 'refresh-token-value',
  profile: { id: 'user-1', email: 'dev@jambu.test', name: 'Dev' },
};

beforeEach(() => {
  areas = installFakeChrome();
});

afterEach(() => {
  uninstallFakeChrome();
});

describe('auth state survives termination', () => {
  it('reports the signed-in user before any restart', async () => {
    await saveSession(SESSION);
    const state = await resolveAuthState();

    expect(state.signedIn).toBe(true);
    expect(state.profile?.email).toBe('dev@jambu.test');
  });

  it('still reports it after the worker is terminated and revived', async () => {
    await saveSession(SESSION);

    // Everything the worker held in memory is gone.
    simulateWorkerRestart(areas);

    const state = await resolveAuthState();
    expect(state.signedIn).toBe(true);
    expect(state.profile?.email).toBe('dev@jambu.test');
  });

  it('still reports it after a full browser restart, when the access token is gone', async () => {
    await saveSession(SESSION);
    simulateBrowserRestart(areas);

    const state = await resolveAuthState();
    expect(state.signedIn).toBe(true);
    expect(state.profile?.email).toBe('dev@jambu.test');
  });

  it('reports signed out when the refresh token is gone', async () => {
    const state = await resolveAuthState();
    expect(state.signedIn).toBe(false);
    expect(state.profile).toBeNull();
  });

  it('reads storage on every call rather than caching', async () => {
    expect((await resolveAuthState()).signedIn).toBe(false);
    await saveSession(SESSION);
    // A cached answer would still say false here.
    expect((await resolveAuthState()).signedIn).toBe(true);
  });
});

describe('listener registration', () => {
  it('does not throw when chrome.runtime is unavailable', () => {
    uninstallFakeChrome();
    expect(() => registerListeners(undefined)).not.toThrow();
  });
});

describe('MV3 lifecycle discipline', () => {
  it('uses no setTimeout or setInterval in background code', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('./service-worker.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    // Pending timers die with the worker; scheduling is chrome.alarms in P9.
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
    expect(source).not.toMatch(/\bsetInterval\s*\(/);
  });
});
