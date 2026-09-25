/**
 * @vitest-environment jsdom
 *
 * The popup's entry points (decisions D58, D92, D96).
 *
 * D96 exists because of a real blocker found in P12 manual acceptance:
 * registration lived only behind the tab that opened itself at install time,
 * so once that tab was closed there was no way to create an account. The
 * first describe block below is the regression guard for exactly that.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeChrome, type FakeAreas } from '../lib/chrome-fake.test-helpers.js';
import * as control from '../lib/control.js';
import * as preferences from '../lib/preferences.js';
import { STORAGE_KEYS, saveSession } from '../lib/storage.js';
import { App } from './App.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ONBOARDING_URL = 'chrome-extension://abc/onboarding/index.html';

let container: HTMLElement;
let root: Root;
let areas: FakeAreas;
let created: { url?: string }[];
let optionsPageCalls: number;

/**
 * Give the chrome double the APIs the popup's navigation reaches for.
 *
 * `openOptionsPage` is modelled the way Chrome really behaves: it takes a
 * callback and reports failure through `runtime.lastError`, never by throwing.
 * That shape is the whole point — the original bug was that nothing read it.
 */
function withTabs(options: { optionsPage?: 'ok' | 'fails' | 'missing' } = {}): void {
  created = [];
  optionsPageCalls = 0;
  const behaviour = options.optionsPage ?? 'ok';
  const existing = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};

  // Built fresh rather than spread from the previous runtime: spreading
  // carried `openOptionsPage` into the "missing" case and quietly made that
  // test meaningless.
  const runtime: Record<string, unknown> = {
    onMessage: { addListener: () => undefined },
    getURL: (path: string) => `chrome-extension://abc/${path}`,
    lastError: undefined,
  };

  if (behaviour !== 'missing') {
    runtime['openOptionsPage'] = (callback?: () => void) => {
      optionsPageCalls += 1;
      runtime['lastError'] =
        behaviour === 'fails'
          ? { message: 'No options page for this extension.' }
          : undefined;
      callback?.();
      runtime['lastError'] = undefined;
    };
  }

  (globalThis as { chrome?: unknown }).chrome = {
    ...existing,
    tabs: {
      create: async (created_options: { url?: string }) => {
        created.push(created_options);
      },
    },
    runtime,
  };
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function byTestId(id: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

/**
 * Stub the two calls the signed-in popup makes on mount.
 *
 * `fetchPause` was previously left unmocked, so it attempted a real request
 * and its rejection raced the assertions — the onboarding-note test passed or
 * failed depending on timing.
 */
function stubPopupState(onboardingCompletedAt: string | null): void {
  vi.spyOn(preferences, 'fetchPreferences').mockResolvedValue({
    workStart: '09:00',
    workEnd: '18:00',
    lunchEnabled: true,
    breakEnabled: true,
    hydrationEnabled: false,
    endDayEnabled: true,
    persona: 'mom',
    timezone: 'UTC',
    onboardingCompletedAt,
  } as never);
  vi.spyOn(control, 'fetchPause').mockResolvedValue({
    paused: false,
    pausedAt: null,
    pausedUntil: null,
  } as never);
}

async function signedIn(): Promise<void> {
  await saveSession({
    accessToken: 'access',
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh',
    profile: { id: 'u1', email: 'someone@example.com' },
  });
}

beforeEach(() => {
  areas = installFakeChrome();
  withTabs();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('reaching registration while signed out (decision D96)', () => {
  it('offers a "Create account" action', async () => {
    await mount();

    const action = byTestId('create-account');
    expect(action).not.toBeNull();
    expect(action?.textContent).toBe('Create account');
  });

  it('opens the onboarding page when it is clicked', async () => {
    await mount();

    await act(async () => {
      byTestId('create-account')?.click();
    });

    // The whole point of D96: reachable without reinstalling the extension.
    expect(created).toEqual([{ url: ONBOARDING_URL }]);
  });

  it('does not duplicate the registration form in the popup', async () => {
    await mount();

    // Exactly the two sign-in fields; registration stays on the onboarding
    // page (D85, D87). A confirm-password or name field here would mean the
    // form had been copied.
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs.map((i) => i.type)).toEqual(['email', 'password']);
    expect(container.textContent).not.toMatch(/confirm password|your name/i);
  });

  it('keeps sign-in the primary action', async () => {
    await mount();

    const submit = buttons().find((b) => b.type === 'submit');
    expect(submit?.textContent).toBe('Sign in');
    // The new action is secondary: it is not a second submit button.
    expect(byTestId('create-account')?.type).toBe('button');
  });

  it('reaches registration even with a half-finished flow stored', async () => {
    // The blocker case: someone closed the install tab mid-onboarding.
    areas.local.set('onboarding.progress', { step: 1, timezone: 'UTC' });
    await mount();

    await act(async () => {
      byTestId('create-account')?.click();
    });
    expect(created).toEqual([{ url: ONBOARDING_URL }]);
  });
});

describe('the signed-in popup', () => {
  it('shows the account and no registration action', async () => {
    stubPopupState('2026-09-24T07:30:00.000Z');
    await signedIn();
    await mount();

    expect(byTestId('profile-email')?.textContent).toBe('someone@example.com');
    expect(byTestId('create-account')).toBeNull();
  });

  it('offers the way back when onboarding is unfinished (decision D92)', async () => {
    stubPopupState(null);
    await signedIn();
    await mount();

    expect(byTestId('resume-onboarding-note')).not.toBeNull();

    const finish = buttons().find((b) => b.textContent === 'Finish setup');
    await act(async () => {
      finish?.click();
    });
    expect(created).toEqual([{ url: ONBOARDING_URL }]);
  });
});

describe('accessibility (CLAUDE.md §19)', () => {
  it('gives every control an accessible name', async () => {
    await mount();

    for (const button of buttons()) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps every control reachable by keyboard', async () => {
    await mount();

    for (const button of buttons()) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('reaching settings from the popup (decision D97)', () => {
  const OPTIONS_URL = 'chrome-extension://abc/options/index.html';

  async function signedInPopup(): Promise<void> {
    stubPopupState('2026-09-24T07:30:00.000Z');
    await signedIn();
    await mount();
  }

  it('asks Chrome to open the options page', async () => {
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId('row-settings')?.click();
    });

    expect(optionsPageCalls).toBe(1);
  });

  it('opens it from the header gear too', async () => {
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId('open-settings')?.click();
    });

    expect(optionsPageCalls).toBe(1);
  });

  it('falls back to a tab when Chrome reports a failure', async () => {
    // This is the blocker: an extension loaded before `options_ui` existed
    // reports "No options page for this extension" through `lastError`. The
    // old code never read it, so the click did nothing at all.
    withTabs({ optionsPage: 'fails' });
    await signedInPopup();

    await act(async () => {
      byTestId('row-settings')?.click();
    });

    expect(optionsPageCalls).toBe(1);
    expect(created).toEqual([{ url: OPTIONS_URL }]);
  });

  it('falls back when openOptionsPage is unavailable entirely', async () => {
    withTabs({ optionsPage: 'missing' });
    await signedInPopup();

    await act(async () => {
      byTestId('row-settings')?.click();
    });

    expect(created).toEqual([{ url: OPTIONS_URL }]);
  });

  it('does not open a tab when Chrome succeeds', async () => {
    // The fallback must stay a fallback — two tabs would be worse than none.
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId('row-settings')?.click();
    });

    expect(created).toEqual([]);
  });

  it('still reaches the options page when a delete row has to fall back', async () => {
    withTabs({ optionsPage: 'fails' });
    await signedInPopup();

    await act(async () => {
      byTestId('row-delete-account')?.click();
    });

    expect(created).toEqual([{ url: OPTIONS_URL }]);
  });
});

/**
 * Regression guard for the second P13 blocker.
 *
 * Every settings-bound row used to call the same `openSettings`, so "Delete my
 * account" behaved exactly like "Settings" — it opened the options page at the
 * default Reminders section. The previous version of this file asserted that
 * sameness, which is how the bug survived review. These assert the opposite.
 */
describe('each popup row reaches its own destination (decision D97)', () => {
  async function signedInPopup(): Promise<void> {
    stubPopupState('2026-09-24T07:30:00.000Z');
    await signedIn();
    await mount();
  }

  const pending = (): unknown => areas.session.get(STORAGE_KEYS.pendingOptionsView);

  it.each([
    ['row-export', 'export'],
    ['row-delete-activity', 'delete-activity'],
    ['row-delete-account', 'delete-account'],
  ])('%s asks for the %s flow', async (row, expected) => {
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId(row)?.click();
    });

    expect(pending()).toBe(expected);
    expect(optionsPageCalls).toBe(1);
  });

  it('gives the three rows three different destinations', async () => {
    withTabs();
    await signedInPopup();

    const seen: unknown[] = [];
    for (const row of ['row-export', 'row-delete-activity', 'row-delete-account']) {
      await act(async () => {
        byTestId(row)?.click();
      });
      seen.push(pending());
    }

    expect(new Set(seen).size).toBe(3);
  });

  it('leaves no destination behind for plain Settings', async () => {
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId('row-settings')?.click();
    });

    // Settings means "the settings page", not a particular flow.
    expect(pending()).toBeUndefined();
    expect(optionsPageCalls).toBe(1);
  });

  it('leaves no destination behind for the header gear', async () => {
    withTabs();
    await signedInPopup();

    await act(async () => {
      byTestId('open-settings')?.click();
    });

    expect(pending()).toBeUndefined();
  });
});
