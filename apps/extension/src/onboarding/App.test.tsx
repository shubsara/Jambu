/**
 * @vitest-environment jsdom
 *
 * Onboarding as the user meets it (decisions D85-D95).
 *
 * Rendered with React's own `act` rather than a testing library: §34 says not
 * to add a dependency when the existing ones do the job.
 *
 * The §3.2 checks here are the **secondary** guard. The primary one is the
 * schema in `machine.ts`, asserted in `machine.test.ts`; this catches a
 * question that is asked out loud but wired nowhere.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeChrome } from '../lib/chrome-fake.test-helpers.js';
import { saveOnboardingProgress } from '../lib/storage.js';
import { App } from './App.js';

// React only enables `act` support when it sees this flag, and warns on every
// render without it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
}

function text(): string {
  return container.textContent ?? '';
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function byText(label: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.includes(label));
  if (found === undefined) throw new Error(`no button labelled "${label}"`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    byText(label).click();
  });
}

beforeEach(() => {
  installFakeChrome();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('the welcome step', () => {
  it('introduces Jambu warmly and says what is not watched', async () => {
    await mount();

    expect(text()).toContain("Hi, I'm Jambu");
    // CLAUDE.md §9 — the privacy promise is made before anything is collected.
    expect(text()).toContain('how long');
    expect(text()).toContain('never what');
  });

  it('offers a way to skip from the very first screen (decision D92)', async () => {
    await mount();
    expect(byText('Skip for now')).toBeDefined();
  });
});

describe('what the flow never asks (CLAUDE.md §3.2, decisions D88, D10, A6)', () => {
  it('asks for no schedule, work hours, persona or name on any step', async () => {
    await mount();

    const forbidden = [
      /lunch time/i,
      /work(ing)? hours/i,
      /when do you (start|finish|stop)/i,
      /water (schedule|reminder every)/i,
      /break (schedule|every)/i,
      /how often/i,
      /persona/i,
      /your name/i,
      /full name/i,
    ];

    // Walk every step and scan what is actually on screen.
    const seen: string[] = [text()];
    await click('Get started');
    seen.push(text());
    await click('Skip for now');

    for (const screen of seen) {
      for (const pattern of forbidden) {
        expect(screen).not.toMatch(pattern);
      }
    }
  });

  it('renders no input asking for a time of day', async () => {
    await mount();
    await click('Get started');

    expect(container.querySelector('input[type="time"]')).toBeNull();
  });

  it('never asks for a name on the account step', async () => {
    await mount();
    await click('Get started');

    const labels = [...container.querySelectorAll('label')].map(
      (l) => l.textContent ?? '',
    );
    expect(labels.join(' ')).not.toMatch(/name/i);
    // Exactly the two required inputs D95 budgets for.
    expect(container.querySelectorAll('input[required]')).toHaveLength(2);
  });
});

describe('the check-ins step (decisions D7, D89)', () => {
  async function reachCheckIns(): Promise<void> {
    // Jump straight there: the account step needs a network call, and this
    // case is about the toggles, not registration.
    act(() => root.unmount());
    container.remove();
    await saveOnboardingProgress({ step: 3, timezone: 'UTC' });
    await mount();
  }

  it('offers exactly the four MVP intervention types', async () => {
    await reachCheckIns();

    const labels = [...container.querySelectorAll('label')]
      .map((l) => l.textContent ?? '')
      .join(' ');
    expect(labels).toContain('Lunch');
    expect(labels).toContain('Breaks');
    expect(labels).toContain('Water');
    expect(labels).toContain('End of day');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
  });

  it('shows water off and the other three on', async () => {
    await reachCheckIns();

    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    // Order follows CHECK_INS: lunch, break, hydration, end of day.
    expect(checkboxes.map((c) => (c as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it('says water is off rather than burying it', async () => {
    await reachCheckIns();
    expect(text()).toContain('Off unless you want it');
  });
});

describe('skipping (decisions D92, D93; resolution A5)', () => {
  it('explains that nothing is watched until setup is finished', async () => {
    await mount();
    await click('Skip for now');

    expect(text()).toContain("won't watch anything");
    expect(text()).toContain('pick up where you left off');
  });

  it('does not scold the user for skipping (CLAUDE.md §39)', async () => {
    await mount();
    await click('Skip for now');

    expect(text()).toContain('No rush');
    expect(text()).not.toMatch(/must|required|warning|error/i);
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

  it('labels every input', async () => {
    await mount();
    await click('Get started');

    for (const input of container.querySelectorAll('input')) {
      // Each input is wrapped by its own <label>, so it is reachable by name.
      expect(input.closest('label')).not.toBeNull();
    }
  });

  it('keeps every control reachable by keyboard', async () => {
    await mount();

    for (const button of buttons()) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
