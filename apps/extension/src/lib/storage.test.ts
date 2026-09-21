/**
 * Token storage split (decision D53).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installFakeChrome,
  simulateBrowserRestart,
  simulateWorkerRestart,
  uninstallFakeChrome,
  type FakeAreas,
} from './chrome-fake.test-helpers.js';
import {
  STORAGE_KEYS,
  clearSession,
  hasSession,
  readAccessToken,
  readProfile,
  readRefreshToken,
  saveRefreshedTokens,
  saveSession,
} from './storage.js';

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

describe('where each token is written', () => {
  it('keeps the access token out of disk-backed storage', async () => {
    await saveSession(SESSION);

    expect(areas.session.get(STORAGE_KEYS.accessToken)).toBe(SESSION.accessToken);
    expect(areas.local.get(STORAGE_KEYS.accessToken)).toBeUndefined();
  });

  it('keeps the refresh token where it survives a restart', async () => {
    await saveSession(SESSION);

    expect(areas.local.get(STORAGE_KEYS.refreshToken)).toBe(SESSION.refreshToken);
    expect(areas.session.get(STORAGE_KEYS.refreshToken)).toBeUndefined();
  });

  it('reads back what it wrote', async () => {
    await saveSession(SESSION);

    expect(await readAccessToken()).toEqual({
      token: SESSION.accessToken,
      expiresAt: SESSION.accessExpiresAt,
    });
    expect(await readRefreshToken()).toBe(SESSION.refreshToken);
    expect(await readProfile()).toEqual(SESSION.profile);
  });
});

describe('surviving restarts', () => {
  it('stays signed in when the service worker is terminated', async () => {
    await saveSession(SESSION);
    simulateWorkerRestart(areas);

    expect(await hasSession()).toBe(true);
    expect((await readProfile())?.email).toBe('dev@jambu.test');
    // The access token is browser-held, so it also survives a worker restart.
    expect((await readAccessToken())?.token).toBe(SESSION.accessToken);
  });

  it('stays signed in across a browser restart, without the access token', async () => {
    await saveSession(SESSION);
    simulateBrowserRestart(areas);

    // The short-lived token is gone by design; the session is not.
    expect(await readAccessToken()).toBeNull();
    expect(await readRefreshToken()).toBe(SESSION.refreshToken);
    expect(await hasSession()).toBe(true);
  });

  it('reports no session when the refresh token is gone', async () => {
    await saveSession(SESSION);
    areas.local.delete(STORAGE_KEYS.refreshToken);

    // Decision D53: this is the signal to route back to sign-in.
    expect(await hasSession()).toBe(false);
  });
});

describe('updating and clearing', () => {
  it('replaces tokens without disturbing the stored profile', async () => {
    await saveSession(SESSION);
    await saveRefreshedTokens({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accessExpiresAt: Date.now() + 7_200_000,
    });

    expect((await readAccessToken())?.token).toBe('new-access');
    expect(await readRefreshToken()).toBe('new-refresh');
    expect((await readProfile())?.email).toBe('dev@jambu.test');
  });

  it('clears both areas on sign-out', async () => {
    await saveSession(SESSION);
    await clearSession();

    expect(areas.session.size).toBe(0);
    expect(areas.local.size).toBe(0);
    expect(await hasSession()).toBe(false);
  });
});

describe('when chrome.storage is unavailable', () => {
  it('does not fall back to disk for the access token', async () => {
    uninstallFakeChrome();
    await saveSession(SESSION);

    // The in-memory fallback still answers, and nothing was written anywhere
    // a later process could read.
    expect((await readAccessToken())?.token).toBe(SESSION.accessToken);
  });
});
