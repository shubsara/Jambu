/**
 * Care Card orchestration (ARCHITECTURE.md §9, decisions D67, D73, D74).
 *
 * Both delivery paths, the fallback, and the duplicate guard — exercised, not
 * assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRefreshState } from '../lib/api-client.js';
import {
  installFakeChrome,
  uninstallFakeChrome,
  type FakeAreas,
} from '../lib/chrome-fake.test-helpers.js';
import { saveSession } from '../lib/storage.js';
import { pollInterventions } from './intervention-poll.js';
import {
  buildCardContent,
  deliver,
  deliverFirst,
  isInjectable,
  type PendingIntervention,
} from './notification-orchestrator.js';
import { submitResponse } from './response-submitter.js';
import { forgetShown, hasBeenShown, markShown, shownCount } from './shown-registry.js';

let areas: FakeAreas;

const NOW = new Date('2026-09-22T13:30:00.000Z');

const INTERVENTION: PendingIntervention = {
  id: '11111111-2222-4333-8444-555555555555',
  type: 'lunch',
  persona: 'mom',
  message: 'Hey! Have you taken your lunch? ❤️',
  expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
};

const fastDeps = {
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  sleep: async () => undefined,
  now: () => Date.now(),
};

async function signIn(): Promise<void> {
  await saveSession({
    accessToken: 'a',
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'r',
    profile: { id: 'u', email: 'p10@jambu.test' },
  });
}

interface ChromeStubs {
  readonly tabUrl?: string | undefined;
  readonly tabId?: number | undefined;
  readonly injectThrows?: boolean;
  readonly notifyThrows?: boolean;
}

function stubChromeApis(options: ChromeStubs = {}) {
  const executeScript = vi.fn(async () => {
    if (options.injectThrows === true) {
      throw new Error('Cannot access contents of the page');
    }
    return [];
  });
  const sendMessage = vi.fn(async () => undefined);
  const createNotification = vi.fn(async () => {
    if (options.notifyThrows === true) {
      throw new Error('notifications suppressed');
    }
    return 'id';
  });
  const query = vi.fn(async () =>
    options.tabUrl === undefined && options.tabId === undefined
      ? []
      : [{ id: options.tabId ?? 1, url: options.tabUrl }],
  );

  const chromeGlobal = globalThis.chrome as unknown as Record<string, unknown>;
  chromeGlobal['tabs'] = { query, sendMessage };
  chromeGlobal['scripting'] = { executeScript };
  chromeGlobal['runtime'] = {
    ...(chromeGlobal['runtime'] as object),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  };
  chromeGlobal['notifications'] = { create: createNotification };

  // The orchestrator reads its own stylesheet through fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('.jambu-card{}', { status: 200 })),
  );

  return { executeScript, sendMessage, createNotification, query };
}

beforeEach(() => {
  areas = installFakeChrome();
  __resetRefreshState();
});

afterEach(() => {
  uninstallFakeChrome();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('card content comes from the persona registry (decision D10)', () => {
  it('uses the persona signature rather than inventing one', () => {
    const content = buildCardContent(INTERVENTION);

    expect(content.signature).toBe('— Mom ❤️');
    expect(content.message).toBe(INTERVENTION.message);
    expect(content.confirmLabel).toBe('Yes, I have');
    expect(content.snoozeLabel).toBe('Remind me later');
  });

  it('carries only what the card displays — nothing about the page', () => {
    expect(Object.keys(buildCardContent(INTERVENTION)).sort()).toEqual([
      'avatar',
      'confirmLabel',
      'greeting',
      'interventionId',
      'message',
      'signature',
      'snoozeLabel',
    ]);
  });

  it('refuses an unknown persona rather than substituting one', () => {
    expect(() => buildCardContent({ ...INTERVENTION, persona: 'dad' })).toThrow(
      /Unknown persona/,
    );
  });
});

describe('which pages can host a card', () => {
  it('accepts only http and https', () => {
    expect(isInjectable('https://notion.so/doc')).toBe(true);
    expect(isInjectable('http://localhost:3000')).toBe(true);

    for (const url of [
      'chrome://extensions',
      'chrome-extension://abc/popup.html',
      'about:blank',
      'file:///Users/someone/doc.pdf',
      undefined,
    ]) {
      expect(isInjectable(url)).toBe(false);
    }
  });
});

describe('delivery (decision D67)', () => {
  it('injects the card into the active tab', async () => {
    const { executeScript, sendMessage } = stubChromeApis({
      tabUrl: 'https://notion.so/doc',
      tabId: 7,
    });

    expect(await deliver(INTERVENTION, NOW)).toBe('card');
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content/care-card.js'],
    });

    const call = sendMessage.mock.calls[0] as unknown as [
      number,
      { type: string; content: { message: string }; css: string },
    ];
    expect(call[0]).toBe(7);
    expect(call[1].type).toBe('jambu:show-card');
    expect(call[1].content.message).toContain('lunch');
    expect(call[1].css).toContain('.jambu-card');
  });

  it('falls back to a notification on an uninjectable page', async () => {
    const { executeScript, createNotification } = stubChromeApis({
      tabUrl: 'chrome://extensions',
      tabId: 7,
    });

    expect(await deliver(INTERVENTION, NOW)).toBe('notification');
    expect(executeScript).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
  });

  it('falls back when there is no focused window at all', async () => {
    const { createNotification } = stubChromeApis({});

    expect(await deliver(INTERVENTION, NOW)).toBe('notification');
    expect(createNotification).toHaveBeenCalled();
  });

  it('falls back when injection is refused despite an http URL', async () => {
    const { createNotification } = stubChromeApis({
      tabUrl: 'https://chromewebstore.google.com/x',
      tabId: 7,
      injectThrows: true,
    });

    expect(await deliver(INTERVENTION, NOW)).toBe('notification');
    expect(createNotification).toHaveBeenCalled();
  });

  it('never hunts for another tab (decision D67)', async () => {
    const { executeScript, query } = stubChromeApis({
      tabUrl: 'chrome://extensions',
      tabId: 7,
    });

    await deliver(INTERVENTION, NOW);

    // One query, for the focused window only.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('reports failure when neither path works', async () => {
    stubChromeApis({ tabUrl: 'chrome://extensions', tabId: 7, notifyThrows: true });

    expect(await deliver(INTERVENTION, NOW)).toBe('failed');
    // Nothing was shown, so nothing is marked shown.
    expect(await hasBeenShown(INTERVENTION.id, NOW)).toBe(false);
  });
});

describe('duplicate suppression (decision D74)', () => {
  it('shows an intervention once, however many times it surfaces', async () => {
    const { executeScript } = stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });

    expect(await deliver(INTERVENTION, NOW)).toBe('card');
    expect(await deliver(INTERVENTION, NOW)).toBe('suppressed');
    expect(await deliver(INTERVENTION, NOW)).toBe('suppressed');

    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('forgets an intervention once it is answered', async () => {
    await markShown(INTERVENTION.id, NOW);
    expect(await hasBeenShown(INTERVENTION.id, NOW)).toBe(true);

    await forgetShown(INTERVENTION.id, NOW);
    expect(await hasBeenShown(INTERVENTION.id, NOW)).toBe(false);
  });

  it('prunes entries past the expiry window, so storage cannot grow forever', async () => {
    await markShown('old-1', NOW);
    await markShown('old-2', NOW);
    expect(await shownCount(NOW)).toBe(2);

    const muchLater = new Date(NOW.getTime() + 31 * 60_000);
    expect(await shownCount(muchLater)).toBe(0);

    await markShown('fresh', muchLater);
    const stored = JSON.stringify([...areas.local.entries()]);
    expect(stored).not.toContain('old-1');
    expect(stored).toContain('fresh');
  });

  it('delivers the first unsuppressed intervention and stops', async () => {
    const { executeScript } = stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });
    const second = { ...INTERVENTION, id: 'second-id' };

    expect(await deliverFirst([INTERVENTION, second], NOW)).toBe('card');
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(await hasBeenShown(second.id, NOW)).toBe(false);
  });
});

describe('the D4 fallback poll (decision D73)', () => {
  it('does nothing when signed out', async () => {
    stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });
    expect(await pollInterventions(NOW, fastDeps)).toBe('skipped');
  });

  it('delivers an unanswered intervention found by the poll', async () => {
    await signIn();
    const { executeScript } = stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/interventions/today')
          ? new Response(
              JSON.stringify({ interventions: [{ ...INTERVENTION, response: null }] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response('.jambu-card{}', { status: 200 }),
      ),
    );

    expect(await pollInterventions(NOW, fastDeps)).toBe('delivered');
    expect(executeScript).toHaveBeenCalled();
  });

  it('ignores interventions that are already answered or expired', async () => {
    await signIn();
    stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              interventions: [
                { ...INTERVENTION, id: 'answered', response: 'confirmed' },
                {
                  ...INTERVENTION,
                  id: 'stale',
                  response: null,
                  expiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    expect(await pollInterventions(NOW, fastDeps)).toBe('nothing');
  });

  it('survives an outage without throwing', async () => {
    await signIn();
    stubChromeApis({ tabUrl: 'https://notion.so', tabId: 7 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    expect(await pollInterventions(NOW, fastDeps)).toBe('nothing');
  });
});

describe('submitting the answer', () => {
  it('posts the response and clears the duplicate guard', async () => {
    await signIn();
    await markShown(INTERVENTION.id, NOW);

    let sentUrl = '';
    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sentUrl = String(url);
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ id: INTERVENTION.id }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    expect(await submitResponse(INTERVENTION.id, 'confirmed', NOW, fastDeps)).toBe(true);
    expect(sentUrl).toContain(`/api/interventions/${INTERVENTION.id}/response`);
    expect(JSON.parse(sentBody)).toEqual({ response: 'confirmed' });
    expect(await hasBeenShown(INTERVENTION.id, NOW)).toBe(false);
  });

  it('sends "Remind me later" as a snooze', async () => {
    await signIn();

    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await submitResponse(INTERVENTION.id, 'snoozed', NOW, fastDeps);
    expect(JSON.parse(sentBody)).toEqual({ response: 'snoozed' });
  });

  it('reports failure without throwing when the API is unreachable', async () => {
    await signIn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    expect(await submitResponse(INTERVENTION.id, 'confirmed', NOW, fastDeps)).toBe(false);
  });
});

describe('nothing about the page reaches storage', () => {
  it('stores only intervention ids in the shown registry', async () => {
    stubChromeApis({ tabUrl: 'https://notion.so/salary-review?token=secret', tabId: 7 });

    await deliver(INTERVENTION, NOW);

    const stored = JSON.stringify([...areas.local.entries()]);
    expect(stored).toContain(INTERVENTION.id);
    expect(stored).not.toContain('salary-review');
    expect(stored).not.toContain('secret');
    expect(stored).not.toMatch(/https?:\/\//);
  });
});
