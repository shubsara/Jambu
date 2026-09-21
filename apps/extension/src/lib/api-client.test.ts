/**
 * API client behaviour (decisions D54, D56, CLAUDE.md §26).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  PROACTIVE_REFRESH_WINDOW_MS,
  RETRY_SCHEDULE_MS,
  SessionExpiredError,
  __resetRefreshState,
  authedRequest,
  publicRequest,
} from './api-client.js';
import {
  installFakeChrome,
  uninstallFakeChrome,
  type FakeAreas,
} from './chrome-fake.test-helpers.js';
import { hasSession, readAccessToken, saveSession } from './storage.js';

let areas: FakeAreas;
let slept: number[];

function deps(fetchImpl: typeof globalThis.fetch, now = () => Date.now()) {
  return {
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    now,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function signedIn(expiresInMs = 3_600_000): Promise<void> {
  await saveSession({
    accessToken: 'access-1',
    accessExpiresAt: Date.now() + expiresInMs,
    refreshToken: 'refresh-1',
    profile: { id: 'u1', email: 'dev@jambu.test' },
  });
}

beforeEach(() => {
  areas = installFakeChrome();
  slept = [];
  __resetRefreshState();
});

afterEach(() => {
  uninstallFakeChrome();
  vi.restoreAllMocks();
});

describe('backoff (CLAUDE.md §26)', () => {
  it('retries a 503 on the bounded schedule and then gives up', async () => {
    const fetchImpl = vi.fn(async () => json({ error: {} }, 503));

    await expect(
      publicRequest('/api/auth/login', {}, deps(fetchImpl as never)),
    ).rejects.toBeInstanceOf(Error);

    // One initial attempt plus one per scheduled delay — never unbounded.
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_SCHEDULE_MS.length + 1);
    expect(slept).toEqual([...RETRY_SCHEDULE_MS]);
  });

  it('backs off progressively rather than hammering', async () => {
    expect([...RETRY_SCHEDULE_MS]).toEqual([...RETRY_SCHEDULE_MS].sort((a, b) => a - b));
    expect(RETRY_SCHEDULE_MS.length).toBeLessThanOrEqual(5);
  });

  it('retries a network failure, so an unreachable API does not break the shell', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      publicRequest('/api/auth/login', {}, deps(fetchImpl as never)),
    ).rejects.toThrow(/Failed to fetch/);
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_SCHEDULE_MS.length + 1);
  });

  it('does not retry a 4xx, which will not fix itself', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' },
        },
        401,
      ),
    );

    await expect(
      publicRequest('/api/auth/login', {}, deps(fetchImpl as never)),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('surfaces the API message without inventing one', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' },
        },
        401,
      ),
    );

    await expect(
      publicRequest('/api/auth/login', {}, deps(fetchImpl as never)),
    ).rejects.toThrow('Email or password is incorrect.');
  });
});

describe('proactive refresh (decision D56)', () => {
  it('refreshes when the token expires inside the 60-second window', async () => {
    await signedIn(PROACTIVE_REFRESH_WINDOW_MS - 1_000);

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return json({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return json({ ok: true });
    });

    await authedRequest('/api/user/state', {}, deps(fetchImpl as never));

    expect(String(fetchImpl.mock.calls.at(0)?.at(0))).toContain('/api/auth/refresh');
    expect((await readAccessToken())?.token).toBe('access-2');
  });

  it('does not refresh a token with plenty of life left', async () => {
    await signedIn(3_600_000);
    const fetchImpl = vi.fn(async () => json({ ok: true }));

    await authedRequest('/api/user/state', {}, deps(fetchImpl as never));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls.at(0)?.at(0))).not.toContain('/api/auth/refresh');
  });
});

describe('single-flight refresh (decision D56)', () => {
  it('collapses concurrent refreshes into one request', async () => {
    await signedIn(-1_000); // already expired

    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        refreshCalls += 1;
        await Promise.resolve();
        return json({
          accessToken: 'access-shared',
          refreshToken: 'refresh-shared',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return json({ ok: true });
    });

    await Promise.all([
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
    ]);

    // Three requests, one refresh — otherwise the losers overwrite the winner.
    expect(refreshCalls).toBe(1);
    expect((await readAccessToken())?.token).toBe('access-shared');
  });
});

describe('reactive refresh and loop safety', () => {
  it('refreshes once on a 401 and retries the original request', async () => {
    await signedIn();

    let attempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return json({
          accessToken: 'access-3',
          refreshToken: 'refresh-3',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      attempts += 1;
      return attempts === 1 ? json({ error: {} }, 401) : json({ ok: true });
    });

    await expect(
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('gives up rather than looping when the retry is also a 401', async () => {
    await signedIn();

    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        refreshCalls += 1;
        return json({
          accessToken: 'access-4',
          refreshToken: 'refresh-4',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return json({ error: {} }, 401);
    });

    await expect(
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
    ).rejects.toBeInstanceOf(SessionExpiredError);

    // Exactly one refresh: a second would be the loop D56 forbids.
    expect(refreshCalls).toBe(1);
    expect(await hasSession()).toBe(false);
  });

  it('clears the session when the refresh itself is rejected', async () => {
    await signedIn(-1_000);
    const fetchImpl = vi.fn(async () => json({ error: {} }, 401));

    await expect(
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
    ).rejects.toBeInstanceOf(SessionExpiredError);

    expect(await hasSession()).toBe(false);
    expect(areas.local.size).toBe(0);
  });

  it('routes to sign-in when there is no refresh token at all', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));

    await expect(
      authedRequest('/api/user/state', {}, deps(fetchImpl as never)),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('request shape', () => {
  it('sends the bearer token, and never in the body', async () => {
    await signedIn();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ ok: true }),
    );

    await authedRequest('/api/user/state', {}, deps(fetchImpl as never));

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer access-1');
    expect(init?.body).toBeUndefined();
  });
});
