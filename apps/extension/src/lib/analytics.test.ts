/**
 * Extension emitter (decisions D112-D114).
 *
 * The extension's call sites are the activity tracker and the onboarding
 * page — the care loop itself — so fail-open matters more here than on the
 * server, and `userId` resolution has to cope with there being no account yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnalyticsEvent } from '@jambu/shared-types';

import { installFakeChrome } from './chrome-fake.test-helpers.js';
import { saveSession } from './storage.js';
import {
  __resetAnalytics,
  emit,
  emitForCurrentUser,
  setAnalyticsSink,
} from './analytics.js';

const AT = '2026-09-21T09:40:00Z';

let seen: AnalyticsEvent[];

/** Let the deferred profile read and emit settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  installFakeChrome();
  seen = [];
  setAnalyticsSink((event) => void seen.push(event));
});

afterEach(() => {
  __resetAnalytics();
});

describe('onboarding_started with no account yet (decisions D113, D114)', () => {
  it('emits with userId null rather than failing or inventing an id', async () => {
    // The account step is second in the flow, so at mount there is no
    // session. D113 accepts null; an anonymous id is explicitly forbidden.
    emitForCurrentUser({ event: 'onboarding_started', occurredAt: AT });
    await flush();

    expect(seen).toEqual([{ event: 'onboarding_started', occurredAt: AT, userId: null }]);
  });

  it('carries the user when one is already signed in (the A3 resume path)', async () => {
    await saveSession({
      accessToken: 'access',
      accessExpiresAt: Date.now() + 60_000,
      refreshToken: 'refresh',
      profile: { id: 'user-1', email: 'someone@example.com' },
    });

    emitForCurrentUser({ event: 'onboarding_started', occurredAt: AT });
    await flush();

    expect(seen[0]?.userId).toBe('user-1');
  });

  it('never carries the profile email', async () => {
    await saveSession({
      accessToken: 'access',
      accessExpiresAt: Date.now() + 60_000,
      refreshToken: 'refresh',
      profile: { id: 'user-1', email: 'someone@example.com' },
    });

    emitForCurrentUser({ event: 'onboarding_started', occurredAt: AT });
    await flush();

    // `StoredProfile` holds an email; only `id` may be read (§9, D113).
    expect(JSON.stringify(seen)).not.toContain('someone@example.com');
    expect(JSON.stringify(seen)).not.toMatch(/@/);
  });
});

describe('event-specific fields survive the userId resolution', () => {
  it('keeps activeSeconds on the activity event', async () => {
    emitForCurrentUser({
      event: 'activity_session_completed',
      occurredAt: AT,
      activeSeconds: 1800,
    });
    await flush();

    expect(seen[0]).toEqual({
      event: 'activity_session_completed',
      occurredAt: AT,
      userId: null,
      activeSeconds: 1800,
    });
  });
});

describe('fail-open and non-blocking (P14 acceptance)', () => {
  it('returns synchronously without waiting for storage', () => {
    // The activity path must not gain a storage round trip between a tab
    // event and the session boundary it produces.
    expect(
      emitForCurrentUser({ event: 'activity_session_started', occurredAt: AT }),
    ).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('survives a throwing sink', async () => {
    setAnalyticsSink(() => {
      throw new Error('boom');
    });
    expect(() =>
      emitForCurrentUser({ event: 'activity_session_started', occurredAt: AT }),
    ).not.toThrow();
    await flush();
  });

  it('is a no-op with no provider configured', async () => {
    __resetAnalytics();
    expect(() =>
      emitForCurrentUser({ event: 'activity_session_started', occurredAt: AT }),
    ).not.toThrow();
    await flush();
  });

  it('survives chrome.storage being unavailable', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    expect(() =>
      emitForCurrentUser({ event: 'activity_session_started', occurredAt: AT }),
    ).not.toThrow();
    await flush();
  });

  it('drops a payload that violates the privacy contract', async () => {
    emit({ event: 'jambu_resumed', occurredAt: AT, userId: 'a@b.com' } as AnalyticsEvent);
    await flush();
    expect(seen).toEqual([]);
  });
});
