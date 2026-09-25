/**
 * Activity tracking, buffering and sync (CLAUDE.md §11, §25, §26).
 *
 * Every case runs against the fake `chrome` APIs with an explicit `now`, so
 * nothing here waits on a real clock or a real browser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRefreshState } from '../lib/api-client.js';
import {
  installFakeChrome,
  simulateWorkerRestart,
  uninstallFakeChrome,
  type FakeAreas,
} from '../lib/chrome-fake.test-helpers.js';
import { cacheOnboardingCompletedAt, clearSession, saveSession } from '../lib/storage.js';
import {
  BUFFER_CAPACITY,
  FLUSH_THRESHOLD,
  appendSession,
  bufferSize,
  clearBuffer,
  readBuffer,
  removeSessions,
  type BufferedSession,
} from './activity-buffer.js';
import { closeSession, currentSession, trackDomain } from './activity-tracker.js';
import { SYNC_ALARM_NAME, SYNC_PERIOD_MINUTES } from './alarms.js';
import { IDLE_DETECTION_SECONDS, handleIdleStateChange } from './idle.js';
import { syncBufferedActivity } from './sync.js';
import { noteActiveUrl } from './tabs.js';

let areas: FakeAreas;

const T0 = new Date('2026-09-22T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function session(overrides: Partial<BufferedSession> = {}): BufferedSession {
  return {
    clientSessionId: crypto.randomUUID(),
    startedAt: T0.toISOString(),
    endedAt: at(10).toISOString(),
    activeSeconds: 600,
    domain: 'notion.so',
    ...overrides,
  };
}

async function signedIn(): Promise<void> {
  await saveSession({
    accessToken: 'access-1',
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-1',
    profile: { id: 'u1', email: 'p9@jambu.test' },
  });
}

/**
 * Signed in **and** onboarded (decision D93).
 *
 * Tracking is gated on onboarding completion, so the P9 behaviour below is
 * only reachable once the user has actually consented. The gate itself is
 * exercised at the bottom of this file.
 */
async function consented(): Promise<void> {
  await signedIn();
  await cacheOnboardingCompletedAt('2026-09-22T08:00:00.000Z');
}

/** Injected so the bounded backoff is exercised without real waiting. */
const fastDeps = {
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  sleep: async () => undefined,
  now: () => Date.now(),
};

function respondWith(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

beforeEach(async () => {
  areas = installFakeChrome();
  __resetRefreshState();
  await consented();
});

afterEach(() => {
  uninstallFakeChrome();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session lifecycle (decision D61)', () => {
  it('opens a session on the first domain seen', async () => {
    await trackDomain('notion.so', T0);

    expect((await currentSession())?.domain).toBe('notion.so');
    expect(await bufferSize()).toBe(0);
  });

  it('extends the open session while the domain is unchanged', async () => {
    await trackDomain('notion.so', T0);
    const first = await currentSession();

    await trackDomain('notion.so', at(5));

    // Same session, not a new one: staying put is not new work.
    expect((await currentSession())?.clientSessionId).toBe(first?.clientSessionId);
    expect(await bufferSize()).toBe(0);
  });

  it('closes one session and opens another when the domain changes', async () => {
    await trackDomain('notion.so', T0);
    await trackDomain('github.com', at(10));

    const buffered = await readBuffer();
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.domain).toBe('notion.so');
    expect(buffered[0]?.activeSeconds).toBe(600);
    expect((await currentSession())?.domain).toBe('github.com');
  });

  it('gives every stored session exactly one domain', async () => {
    await trackDomain('notion.so', T0);
    await trackDomain('github.com', at(5));
    await trackDomain('notion.so', at(9));
    await closeSession(at(12));

    expect((await readBuffer()).map((s) => s.domain)).toEqual([
      'notion.so',
      'github.com',
      'notion.so',
    ]);
  });

  it('records an untrackable page as a domain-null session (decision D66)', async () => {
    await noteActiveUrl('chrome://extensions', T0);
    await noteActiveUrl('https://notion.so/doc', at(4));

    const buffered = await readBuffer();
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.domain).toBeNull();
    // The time still counted.
    expect(buffered[0]?.activeSeconds).toBe(240);
  });

  it('drops a session too short to mean anything', async () => {
    await trackDomain('notion.so', T0);
    // Rapid tab switching, well under a second.
    await trackDomain('github.com', new Date(T0.getTime() + 200));

    expect(await bufferSize()).toBe(0);
  });

  it('closes nothing when no session is open', async () => {
    expect(await closeSession(T0)).toBe(false);
    expect(await bufferSize()).toBe(0);
  });
});

describe('idle handling (decision D62)', () => {
  it('uses a 60-second detection threshold', () => {
    expect(IDLE_DETECTION_SECONDS).toBe(60);
  });

  it('closes the open session when the user goes idle', async () => {
    await trackDomain('notion.so', T0);
    await handleIdleStateChange('idle', at(10));

    expect(await currentSession()).toBeNull();
    expect(await bufferSize()).toBe(1);
  });

  it('treats a locked machine as idle', async () => {
    await trackDomain('notion.so', T0);
    await handleIdleStateChange('locked', at(10));

    expect(await bufferSize()).toBe(1);
  });

  it('does not open a session on becoming active — only a tab event knows the domain', async () => {
    await handleIdleStateChange('active', T0);
    expect(await currentSession()).toBeNull();
  });

  it('does not re-implement the D6 ten-minute rule', async () => {
    // Two sessions thirty minutes apart stay two sessions. Whether they are
    // one stretch of continuous work is decided in P5 derivation, not here.
    await trackDomain('notion.so', T0);
    await handleIdleStateChange('idle', at(5));
    await trackDomain('notion.so', at(35));
    await handleIdleStateChange('idle', at(40));

    expect(await bufferSize()).toBe(2);
  });
});

describe('the buffer survives service-worker termination', () => {
  it('keeps buffered sessions across a restart', async () => {
    await trackDomain('notion.so', T0);
    await trackDomain('github.com', at(10));

    simulateWorkerRestart(areas);

    expect(await bufferSize()).toBe(1);
    expect((await readBuffer())[0]?.domain).toBe('notion.so');
  });

  it('keeps the open session across a restart, so time is not lost', async () => {
    await trackDomain('notion.so', T0);

    simulateWorkerRestart(areas);

    expect((await currentSession())?.domain).toBe('notion.so');
    await closeSession(at(10));
    expect((await readBuffer())[0]?.activeSeconds).toBe(600);
  });
});

describe('buffer capacity and eviction (decision D65)', () => {
  it('caps at the API batch maximum', () => {
    expect(BUFFER_CAPACITY).toBe(500);
    expect(FLUSH_THRESHOLD).toBe(20);
  });

  it('evicts oldest-first only once the cap is exceeded', async () => {
    for (let index = 0; index < BUFFER_CAPACITY; index += 1) {
      await appendSession(session({ clientSessionId: `s-${index}` }));
    }
    expect(await bufferSize()).toBe(BUFFER_CAPACITY);

    await appendSession(session({ clientSessionId: 'newest' }));

    const buffered = await readBuffer();
    expect(buffered).toHaveLength(BUFFER_CAPACITY);
    expect(buffered[0]?.clientSessionId).toBe('s-1');
    expect(buffered.at(-1)?.clientSessionId).toBe('newest');
  });

  it('removes settled sessions by key, not by count', async () => {
    await appendSession(session({ clientSessionId: 'a' }));
    await appendSession(session({ clientSessionId: 'b' }));
    await appendSession(session({ clientSessionId: 'c' }));

    await removeSessions(['a', 'c']);

    expect((await readBuffer()).map((s) => s.clientSessionId)).toEqual(['b']);
  });
});

describe('sync (CLAUDE.md §26)', () => {
  it('does nothing when signed out, keeping the buffer for later', async () => {
    await clearSession();
    await appendSession(session());

    expect(await syncBufferedActivity(fastDeps)).toEqual({
      status: 'idle',
      reason: 'signed-out',
    });
    expect(await bufferSize()).toBe(1);
  });

  it('sends the batch and clears what was accepted', async () => {
    await signedIn();
    await appendSession(session({ clientSessionId: 'a' }));
    await appendSession(session({ clientSessionId: 'b' }));

    vi.stubGlobal(
      'fetch',
      respondWith({ accepted: 2, duplicates: 0, pendingInterventions: [] }),
    );

    expect(await syncBufferedActivity(fastDeps)).toMatchObject({
      status: 'synced',
      accepted: 2,
    });
    expect(await bufferSize()).toBe(0);
  });

  it('keeps everything buffered when the backend is unreachable', async () => {
    await signedIn();
    await appendSession(session());

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    expect(await syncBufferedActivity(fastDeps)).toEqual({ status: 'deferred' });
    expect(await bufferSize()).toBe(1);
  });

  it('survives a 30-minute outage with no loss, then syncs on recovery', async () => {
    await signedIn();

    // Thirty minutes of the backend being down: one worked session per
    // five-minute alarm tick, each sync attempt failing.
    vi.stubGlobal('fetch', respondWith({}, 503));

    for (let tick = 0; tick < 6; tick += 1) {
      const startedAt = tick * 5;
      await trackDomain('notion.so', at(startedAt));
      await handleIdleStateChange('idle', at(startedAt + 4));

      expect(await syncBufferedActivity(fastDeps)).toEqual({ status: 'deferred' });
    }

    const backlog = await bufferSize();
    expect(backlog).toBe(6);
    // Well inside the cap, so decision D65's eviction never engages.
    expect(backlog).toBeLessThan(BUFFER_CAPACITY);

    vi.stubGlobal('fetch', respondWith({ accepted: backlog, duplicates: 0 }));

    expect(await syncBufferedActivity(fastDeps)).toMatchObject({ status: 'synced' });
    expect(await bufferSize()).toBe(0);
  });

  it('discards a permanently invalid batch rather than retrying forever', async () => {
    await signedIn();
    await appendSession(session());

    vi.stubGlobal('fetch', respondWith({ error: { code: 'VALIDATION_FAILED' } }, 400));

    expect(await syncBufferedActivity(fastDeps)).toEqual({
      status: 'discarded',
      count: 1,
    });
    // Otherwise it would block every later session behind it.
    expect(await bufferSize()).toBe(0);
  });

  it('treats duplicates as settled, so a replay does not wedge the buffer', async () => {
    await signedIn();
    await appendSession(session());

    vi.stubGlobal('fetch', respondWith({ accepted: 0, duplicates: 1 }));

    expect(await syncBufferedActivity(fastDeps)).toMatchObject({
      status: 'synced',
      duplicates: 1,
    });
    expect(await bufferSize()).toBe(0);
  });
});

describe('only domains and durations leave the browser (CLAUDE.md §9)', () => {
  it('sends no path, query or fragment, even after visiting URLs that have them', async () => {
    await signedIn();
    await clearBuffer();

    await noteActiveUrl('https://notion.so/salary-review?token=super-secret#draft', T0);
    await noteActiveUrl('https://github.com/user/private-repo', at(10));
    await closeSession(at(20));

    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ accepted: 2, duplicates: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await syncBufferedActivity(fastDeps);

    expect(sentBody).toContain('notion.so');
    expect(sentBody).not.toContain('salary-review');
    expect(sentBody).not.toContain('super-secret');
    expect(sentBody).not.toContain('private-repo');
    expect(sentBody).not.toMatch(/https?:\/\//);
  });

  it('never writes a URL into storage', async () => {
    await noteActiveUrl('https://notion.so/secret-doc?token=abc', T0);
    await noteActiveUrl('https://github.com/x/y', at(5));

    const everythingStored = JSON.stringify([...areas.local.entries()]);
    expect(everythingStored).not.toContain('secret-doc');
    expect(everythingStored).not.toContain('token=abc');
    expect(everythingStored).not.toMatch(/https?:\/\//);
    // The domain itself is expected.
    expect(everythingStored).toContain('notion.so');
  });

  it('omits the domain field entirely for an untrackable page', async () => {
    await signedIn();
    await clearBuffer();
    await appendSession(session({ domain: null }));

    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await syncBufferedActivity(fastDeps);
    expect(sentBody).not.toContain('"domain"');
  });
});

describe('scheduling (decision D64, ARCHITECTURE.md §5.3)', () => {
  it('uses a five-minute alarm', () => {
    expect(SYNC_PERIOD_MINUTES).toBe(5);
    expect(SYNC_ALARM_NAME).toBe('jambu:sync');
  });

  it('uses no setTimeout or setInterval anywhere in background code', () => {
    const files = [
      'activity-buffer.ts',
      'activity-tracker.ts',
      'alarms.ts',
      'flush.ts',
      'idle.ts',
      'service-worker.ts',
      'sync.ts',
      'tabs.ts',
    ];

    for (const file of files) {
      const source = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '');

      // Pending timers die with the worker; scheduling is chrome.alarms only.
      expect(source, file).not.toMatch(/\bsetTimeout\s*\(/);
      expect(source, file).not.toMatch(/\bsetInterval\s*\(/);
    }
  });
});

describe('decision D63 — interventions are ignored in P9', () => {
  it('stores nothing from pendingInterventions', async () => {
    await signedIn();
    await appendSession(session());

    vi.stubGlobal(
      'fetch',
      respondWith({
        accepted: 1,
        duplicates: 0,
        pendingInterventions: [
          { id: 'i1', type: 'lunch', message: 'Hey! Have you taken your lunch?' },
        ],
      }),
    );

    await syncBufferedActivity(fastDeps);

    // P10 owns presentation. Nothing about the card may be retained here.
    const everythingStored = JSON.stringify([...areas.local.entries()]);
    expect(everythingStored).not.toContain('lunch');
    expect(everythingStored).not.toContain('Have you taken');
  });
});

describe('nothing is observed before consent (decision D93)', () => {
  it('records no session from a tab event when onboarding is unfinished', async () => {
    await clearSession();
    await signedIn();

    await noteActiveUrl('https://notion.so/some-page', T0);

    // Not merely unsent — never observed in the first place.
    expect(await currentSession()).toBeNull();
    expect(await bufferSize()).toBe(0);
  });

  it('records nothing for a signed-out browser either', async () => {
    await clearSession();

    await noteActiveUrl('https://notion.so/some-page', T0);
    expect(await currentSession()).toBeNull();
  });

  it('writes no hostname to storage while gated', async () => {
    await clearSession();
    await signedIn();

    await noteActiveUrl('https://notion.so/some-page', T0);

    const everythingStored = JSON.stringify([...areas.local, ...areas.session]);
    expect(everythingStored).not.toContain('notion.so');
  });

  it('starts observing as soon as onboarding completes', async () => {
    await consented();

    await noteActiveUrl('https://notion.so/some-page', T0);
    expect((await currentSession())?.domain).toBe('notion.so');
  });
});
