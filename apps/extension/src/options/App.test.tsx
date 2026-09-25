/**
 * @vitest-environment jsdom
 *
 * Settings (decision D97; board screens 6-10).
 *
 * The cases worth having here are the ones that protect a promise rather than
 * a pixel: that the catalogue stays at four types, that pause offers the four
 * approved durations, that snoozes can be cleared but never created, and that
 * nothing irreversible happens without the phrase typed exactly.
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

let container: HTMLElement;
let root: Root;
let areas: FakeAreas;

const PREFERENCES = {
  workStart: '09:00',
  workEnd: '18:00',
  lunchEnabled: true,
  breakEnabled: true,
  hydrationEnabled: false,
  endDayEnabled: true,
  persona: 'mom',
  timezone: 'Asia/Kolkata',
  onboardingCompletedAt: '2026-09-24T07:30:00.000Z',
};

const NOT_PAUSED = { paused: false, pausedAt: null, pausedUntil: null };

function stub(overrides: { pause?: unknown; snoozes?: unknown } = {}): void {
  vi.spyOn(preferences, 'fetchPreferences').mockResolvedValue(PREFERENCES as never);
  vi.spyOn(preferences, 'updatePreferences').mockResolvedValue(PREFERENCES as never);
  vi.spyOn(control, 'fetchPause').mockResolvedValue(
    (overrides.pause ?? NOT_PAUSED) as never,
  );
  vi.spyOn(control, 'fetchSnoozes').mockResolvedValue((overrides.snoozes ?? []) as never);
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
}

const byTestId = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

async function click(id: string): Promise<void> {
  await act(async () => {
    (byTestId(id) as HTMLElement | null)?.click();
  });
}

async function goTo(section: string): Promise<void> {
  await click(`nav-${section}`);
}

/**
 * Type into a controlled input the way a person would.
 *
 * Assigning `input.value` directly is invisible to React — it tracks the value
 * through the prototype's setter and treats a plain assignment as no change.
 * Going through the native setter is what makes `onChange` fire, and without
 * it a "stays disabled" assertion passes because nothing was ever typed.
 */
async function type(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = byTestId(id) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  areas = installFakeChrome();
  await saveSession({
    accessToken: 'access',
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh',
    profile: { id: 'u1', email: 'someone@example.com' },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('the reminder catalogue (CLAUDE.md §2)', () => {
  it('offers exactly the four MVP types', async () => {
    stub();
    await mount();

    for (const kind of ['lunch', 'break', 'hydration', 'end_of_day']) {
      expect(byTestId(`type-${kind}`)).not.toBeNull();
    }
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
  });

  it('includes Lunch, which the board omits', async () => {
    stub();
    await mount();

    // The Mom Moment is the product's headline behaviour (§5); it must have a
    // control.
    expect(byTestId('type-lunch')?.textContent).toContain('Lunch');
  });

  it('offers no Posture toggle', async () => {
    stub();
    await mount();

    // Not an MVP intervention type — no enum value, no scoring rule, no
    // template. A toggle would control nothing.
    expect(container.textContent).not.toMatch(/posture/i);
  });

  it('shows hydration off and the others on (decisions D7, D89)', async () => {
    stub();
    await mount();

    const checked = [...container.querySelectorAll('input[type="checkbox"]')].map(
      (input) => (input as HTMLInputElement).checked,
    );
    expect(checked).toEqual([true, true, false, true]);
  });

  it('writes the matching preference flag when toggled', async () => {
    stub();
    await mount();

    await act(async () => {
      (byTestId('toggle-hydration') as HTMLInputElement).click();
    });

    expect(preferences.updatePreferences).toHaveBeenCalledWith({
      hydrationEnabled: true,
    });
  });

  it('re-reads snoozes after a toggle, because disabling clears one (D103)', async () => {
    stub();
    await mount();

    const before = vi.mocked(control.fetchSnoozes).mock.calls.length;
    await act(async () => {
      (byTestId('toggle-lunch') as HTMLInputElement).click();
    });

    expect(vi.mocked(control.fetchSnoozes).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('pause (decisions D98, D99)', () => {
  it('offers exactly the four approved durations', async () => {
    stub();
    await mount();
    await goTo('pause');

    for (const id of ['30m', '1h', '2h', 'rest-of-day']) {
      expect(byTestId(`pause-${id}`)).not.toBeNull();
    }
  });

  it('offers no custom time picker', async () => {
    stub();
    await mount();
    await goTo('pause');

    // The board shows "Custom time"; D98 approved four fixed choices, and a
    // picker is the scheduling chore §3.2 avoids.
    expect(container.textContent).not.toMatch(/custom time/i);
  });

  it('says plainly that activity is still tracked (D99)', async () => {
    stub();
    await mount();
    await goTo('pause');

    expect(container.textContent).toContain('activity will still be tracked');
  });

  it('starts a pause when a duration is chosen', async () => {
    stub();
    const startPause = vi
      .spyOn(control, 'startPause')
      .mockResolvedValue({ paused: true, pausedAt: null, pausedUntil: null } as never);

    await mount();
    await goTo('pause');
    await click('pause-1h');

    expect(startPause).toHaveBeenCalledOnce();
    const until = startPause.mock.calls[0]?.[0] as Date;
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it('shows the paused state and a way to resume', async () => {
    stub({
      pause: {
        paused: true,
        pausedAt: new Date().toISOString(),
        pausedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const endPause = vi.spyOn(control, 'endPause').mockResolvedValue(NOT_PAUSED as never);

    await mount();
    await goTo('pause');
    expect(container.textContent).toContain('Reminders paused');

    await click('resume-pause');
    expect(endPause).toHaveBeenCalledOnce();
  });
});

describe('snoozes (decision D102)', () => {
  const SNOOZES = [{ type: 'break', snoozedUntil: new Date().toISOString() }];

  it('lists an active snooze with a way to clear it', async () => {
    stub({ snoozes: SNOOZES });
    const clearSnooze = vi.spyOn(control, 'clearSnooze').mockResolvedValue([] as never);

    await mount();
    await goTo('snoozes');
    expect(byTestId('snooze-break')).not.toBeNull();

    await click('clear-break');
    expect(clearSnooze).toHaveBeenCalledWith('break');
  });

  it('offers no way to create one', async () => {
    stub({ snoozes: SNOOZES });
    await mount();
    await goTo('snoozes');

    expect(container.textContent).toContain("you can't create new snoozes");
    const labels = [...container.querySelectorAll('button')].map(
      (b) => b.textContent ?? '',
    );
    expect(labels.join(' ')).not.toMatch(/add snooze|new snooze|create snooze/i);
  });

  it('says nothing is snoozed when nothing is', async () => {
    stub();
    await mount();
    await goTo('snoozes');

    expect(container.textContent).toContain('Nothing is snoozed');
  });
});

describe('deletion requires the phrase typed exactly (decision D106)', () => {
  async function openDeleteActivity(): Promise<void> {
    stub();
    await mount();
    await goTo('privacy');
    await click('row-delete-activity');
  }

  it('keeps the action disabled until the phrase matches', async () => {
    await openDeleteActivity();

    expect((byTestId('confirm-delete') as HTMLButtonElement).disabled).toBe(true);

    for (const near of ['delete_activity', 'DELETE ACTIVITY', 'DELETE_ACTIVIT']) {
      await type('confirm-input', near);
      expect((byTestId('confirm-delete') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('enables it on an exact match', async () => {
    await openDeleteActivity();
    await type('confirm-input', 'DELETE_ACTIVITY');

    expect((byTestId('confirm-delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns that it cannot be undone', async () => {
    await openDeleteActivity();
    expect(container.textContent).toContain('cannot be undone');
  });

  it('asks for DELETE_ACCOUNT on the account flow', async () => {
    stub();
    await mount();
    await goTo('account');
    await click('row-delete-account');

    expect(byTestId('delete-dialog')?.textContent).toContain('DELETE_ACCOUNT');
  });
});

describe('account deletion is confirmed by acceptance (decisions D104, D107)', () => {
  it('signs out and reports completion without polling', async () => {
    stub();
    const deleteAccount = vi.spyOn(control, 'deleteAccount').mockResolvedValue({
      deletionRequestId: 'req-1',
      scope: 'account',
      status: 'pending',
      message: 'This cannot be undone.',
    } as never);
    const poll = vi.spyOn(control, 'fetchDeletionRequest');

    await mount();
    await goTo('account');
    await click('row-delete-account');
    await type('confirm-input', 'DELETE_ACCOUNT');
    await click('confirm-delete');

    expect(deleteAccount).toHaveBeenCalledWith('DELETE_ACCOUNT');
    // The token is gone with the account, so polling would only 401.
    expect(poll).not.toHaveBeenCalled();
    expect(byTestId('account-deleted')).not.toBeNull();
    expect(container.textContent).toContain('signed out');
  });
});

describe('export (decision D105)', () => {
  it('tells the user about the cap before they download', async () => {
    stub();
    await mount();
    await goTo('privacy');
    await click('row-export');

    expect(container.textContent).toContain('10,000 records per collection');
    expect(container.textContent).toContain('truncated and clearly marked');
  });

  it('promises no URLs or page content (CLAUDE.md §9)', async () => {
    stub();
    await mount();
    await goTo('privacy');
    await click('row-export');

    expect(container.textContent).toContain('no URLs or page content');
  });
});

describe('accessibility (CLAUDE.md §19)', () => {
  it('gives every control an accessible name', async () => {
    stub();
    await mount();

    for (const button of container.querySelectorAll('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
    for (const input of container.querySelectorAll('input')) {
      const labelled =
        input.getAttribute('aria-label') !== null || input.closest('label') !== null;
      expect(labelled).toBe(true);
    }
  });

  it('marks the current section for assistive technology', async () => {
    stub();
    await mount();

    expect(byTestId('nav-reminders')?.getAttribute('aria-current')).toBe('page');
    await goTo('pause');
    expect(byTestId('nav-pause')?.getAttribute('aria-current')).toBe('page');
  });

  it('labels dialogs and closes them on Escape', async () => {
    stub();
    await mount();
    await goTo('privacy');
    await click('row-export');

    expect(byTestId('export-dialog')?.getAttribute('role')).toBe('dialog');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(byTestId('export-dialog')).toBeNull();
  });
});

/**
 * The popup's deep links (decision D97).
 *
 * `chrome.runtime.openOptionsPage()` carries no argument, so the popup leaves
 * a destination in session storage. These prove it is honoured once, cleared
 * immediately, and never trusted blindly.
 */
describe('opening at a flow the popup asked for', () => {
  const setPending = (value: unknown): void => {
    areas.session.set(STORAGE_KEYS.pendingOptionsView, value);
  };

  it('opens the export dialog on Privacy & data', async () => {
    stub();
    setPending('export');
    await mount();

    expect(byTestId('nav-privacy')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('export-dialog')).not.toBeNull();
  });

  it('opens the delete-activity dialog on Privacy & data', async () => {
    stub();
    setPending('delete-activity');
    await mount();

    expect(byTestId('nav-privacy')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('delete-dialog')?.textContent).toContain('DELETE_ACTIVITY');
  });

  it('opens the delete-account dialog on Account', async () => {
    stub();
    setPending('delete-account');
    await mount();

    expect(byTestId('nav-account')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('delete-dialog')?.textContent).toContain('DELETE_ACCOUNT');
  });

  it('consumes the target, so it cannot fire twice', async () => {
    stub();
    setPending('delete-account');
    await mount();
    expect(byTestId('delete-dialog')).not.toBeNull();

    // A target left in place would ambush the next visit with a delete dialog.
    expect(areas.session.get(STORAGE_KEYS.pendingOptionsView)).toBeUndefined();

    act(() => root.unmount());
    container.remove();
    await mount();
    expect(byTestId('delete-dialog')).toBeNull();
    expect(byTestId('nav-reminders')?.getAttribute('aria-current')).toBe('page');
  });

  it('ignores a target outside the allowlist, and still clears it', async () => {
    stub();
    setPending('drop-database');
    await mount();

    expect(byTestId('nav-reminders')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(areas.session.get(STORAGE_KEYS.pendingOptionsView)).toBeUndefined();
  });

  it('opens nothing when no target was left', async () => {
    stub();
    await mount();

    expect(byTestId('nav-reminders')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('still requires the typed phrase on a deep-linked delete', async () => {
    // A deep link may open the dialog; it must never shorten the confirmation.
    stub();
    setPending('delete-account');
    await mount();

    expect((byTestId('confirm-delete') as HTMLButtonElement).disabled).toBe(true);
    await type('confirm-input', 'DELETE_ACCOUNT');
    expect((byTestId('confirm-delete') as HTMLButtonElement).disabled).toBe(false);
  });
});
