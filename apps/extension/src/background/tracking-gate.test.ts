/**
 * The consent gate (decision D93, resolution A5).
 *
 * This is the test that protects a promise rather than a feature: until the
 * user finishes onboarding, Jambu observes nothing. The gate fails closed, so
 * every ambiguous case below must answer "do not track".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFakeChrome, type FakeAreas } from '../lib/chrome-fake.test-helpers.js';
import {
  STORAGE_KEYS,
  cacheOnboardingCompletedAt,
  clearSession,
  saveSession,
} from '../lib/storage.js';
import { mayTrack, openOnboarding } from './tracking-gate.js';

const COMPLETED_AT = '2026-09-24T07:30:00.000Z';

function signIn(): Promise<void> {
  return saveSession({
    accessToken: 'access',
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh',
    profile: { id: 'user-1', email: 'someone@example.com' },
  });
}

let areas: FakeAreas;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mayTrack', () => {
  it('says no when nobody is signed in', async () => {
    areas = installFakeChrome();
    expect(await mayTrack()).toBe(false);
  });

  it('says no when signed in but onboarding is unfinished', async () => {
    areas = installFakeChrome();
    await signIn();

    // This is the skip case (D92): a real account, and nothing watched.
    expect(await mayTrack()).toBe(false);
  });

  it('says yes only once completion has been recorded', async () => {
    areas = installFakeChrome();
    await signIn();
    await cacheOnboardingCompletedAt(COMPLETED_AT);

    expect(await mayTrack()).toBe(true);
  });

  it('says no when onboarding is complete but the user signed out', async () => {
    areas = installFakeChrome();
    await signIn();
    await cacheOnboardingCompletedAt(COMPLETED_AT);
    await clearSession();

    expect(await mayTrack()).toBe(false);
  });

  it('forgets completion on sign-out, so the next user starts gated', async () => {
    areas = installFakeChrome();
    await signIn();
    await cacheOnboardingCompletedAt(COMPLETED_AT);
    await clearSession();

    expect(areas.local.get(STORAGE_KEYS.onboardingCompletedAt)).toBeUndefined();
  });

  it('fails closed when the cache holds something that is not a timestamp', async () => {
    areas = installFakeChrome();
    await signIn();
    areas.local.set(STORAGE_KEYS.onboardingCompletedAt, { not: 'a string' });

    expect(await mayTrack()).toBe(false);
  });

  it('treats an explicit null as not onboarded', async () => {
    areas = installFakeChrome();
    await signIn();
    await cacheOnboardingCompletedAt(COMPLETED_AT);
    await cacheOnboardingCompletedAt(null);

    expect(await mayTrack()).toBe(false);
  });
});

describe('openOnboarding (decision D85)', () => {
  it('opens the onboarding page in a tab', async () => {
    const create = vi.fn(async () => undefined);
    const getURL = vi.fn(() => 'chrome-extension://abc/onboarding/index.html');

    await openOnboarding(
      { create } as unknown as typeof chrome.tabs,
      {
        getURL,
      } as unknown as typeof chrome.runtime,
    );

    expect(getURL).toHaveBeenCalledWith('onboarding/index.html');
    expect(create).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/onboarding/index.html',
    });
  });

  it('does nothing when the tabs API is unavailable', async () => {
    // The worker must still load in a context without it.
    await expect(
      openOnboarding(undefined, {
        getURL: () => 'x',
      } as unknown as typeof chrome.runtime),
    ).resolves.toBeUndefined();
  });
});
