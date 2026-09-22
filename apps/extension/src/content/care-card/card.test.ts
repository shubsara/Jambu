/**
 * @vitest-environment jsdom
 *
 * The Care Card (CLAUDE.md §19, §39; decisions D68, D69, D71).
 *
 * The card is the product, so these cases are about how it behaves for a
 * person: answerable, dismissible, reachable by keyboard, and never taking
 * focus from someone mid-sentence.
 */
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_ID, renderCard, type CardContent, type CardResponse } from './card.js';

// Repo-relative: under jsdom `import.meta.url` is not a file URL. This reads
// the stylesheet that actually ships, so the assertions below are about the
// built artefact rather than a copy.
const CSS = readFileSync('apps/extension/public/content/care-card.css', 'utf8');

const CONTENT: CardContent = {
  interventionId: '11111111-2222-4333-8444-555555555555',
  message: 'Have you taken your lunch? ❤️',
  signature: '— Mom ❤️',
  avatar: '👩',
  greeting: 'Hey! ❤️',
  confirmLabel: 'Yes, I have',
  snoozeLabel: 'Remind me later',
};

function mount(onRespond: (r: CardResponse) => void = () => undefined) {
  return renderCard(document, CONTENT, CSS, onRespond);
}

function buttons(shadow: ShadowRoot): HTMLButtonElement[] {
  return [...shadow.querySelectorAll('button')];
}

function byText(shadow: ShadowRoot, text: string): HTMLButtonElement {
  const found = buttons(shadow).find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button labelled "${text}"`);
  return found;
}

afterEach(() => {
  document.querySelector(`#${HOST_ID}`)?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('rendering', () => {
  it('shows the message, greeting, signature and both actions', () => {
    const { shadow } = mount();

    expect(shadow.textContent).toContain('Have you taken your lunch?');
    expect(shadow.textContent).toContain('Hey!');
    expect(shadow.textContent).toContain('— Mom ❤️');
    expect(byText(shadow, 'Yes, I have')).toBeDefined();
    expect(byText(shadow, 'Remind me later')).toBeDefined();
  });

  it('renders inside a closed shadow root, so the page cannot reach in', () => {
    const { host } = mount();
    expect(host.shadowRoot).toBeNull();
  });

  it('adopts the stylesheet into the shadow root, not the page (decision D75)', () => {
    const { shadow } = mount();

    expect(shadow.querySelector('style')?.textContent).toContain('.jambu-card');
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('replaces an existing card rather than stacking two', () => {
    mount();
    mount();

    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });
});

describe('answering', () => {
  it('reports confirmed and removes itself', () => {
    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);

    byText(shadow, 'Yes, I have').click();

    expect(onRespond).toHaveBeenCalledWith({
      interventionId: CONTENT.interventionId,
      response: 'confirmed',
    });
    expect(document.querySelector(`#${HOST_ID}`)).toBeNull();
  });

  it('reports snoozed for "Remind me later"', () => {
    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);

    byText(shadow, 'Remind me later').click();

    expect(onRespond).toHaveBeenCalledWith({
      interventionId: CONTENT.interventionId,
      response: 'snoozed',
    });
  });

  it('reports dismissed from the close control', () => {
    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);

    byText(shadow, '×').click();

    expect(onRespond).toHaveBeenCalledWith({
      interventionId: CONTENT.interventionId,
      response: 'dismissed',
    });
  });

  it('answers at most once, however many times it is clicked', () => {
    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);
    const confirm = byText(shadow, 'Yes, I have');

    confirm.click();
    confirm.click();
    confirm.click();

    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it('sends back only an id and a response — nothing about the page', () => {
    document.title = 'Salary review — Notion';
    document.body.innerHTML = '<p>confidential text</p>';

    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);
    byText(shadow, 'Yes, I have').click();

    const payload = onRespond.mock.calls[0]?.[0] as CardResponse;
    expect(Object.keys(payload).sort()).toEqual(['interventionId', 'response']);
    expect(JSON.stringify(payload)).not.toContain('Salary');
    expect(JSON.stringify(payload)).not.toContain('confidential');
  });
});

describe('it neither persists an answer nor invents one (decision D69)', () => {
  it('stays on screen while unanswered', () => {
    mount();
    expect(document.querySelector(`#${HOST_ID}`)).not.toBeNull();
  });

  it('never fabricates a response', () => {
    const onRespond = vi.fn();
    mount(onRespond);
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe('accessibility (CLAUDE.md §19)', () => {
  it('is a labelled dialog announced politely', () => {
    const { shadow } = mount();
    const dialog = shadow.querySelector('[role="dialog"]');

    expect(dialog?.getAttribute('aria-label')).toBe('A note from Jambu');
    expect(dialog?.getAttribute('aria-live')).toBe('polite');
  });

  it('does not steal focus when it appears (decision D71)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    mount();

    // Someone typing must not be interrupted.
    expect(document.activeElement).toBe(input);
  });

  it('ignores Escape until the user engages with the card', () => {
    const onRespond = vi.fn();
    mount(onRespond);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    // The page's own Escape handling is not swallowed.
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('dismisses on Escape once the card has focus', () => {
    const onRespond = vi.fn();
    const { shadow } = mount(onRespond);

    byText(shadow, 'Yes, I have').dispatchEvent(new Event('focusin', { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(onRespond).toHaveBeenCalledWith({
      interventionId: CONTENT.interventionId,
      response: 'dismissed',
    });
  });

  it('gives every control an accessible name', () => {
    const { shadow } = mount();

    for (const button of buttons(shadow)) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it('hides the decorative avatar from assistive technology', () => {
    const { shadow } = mount();
    expect(shadow.querySelector('.jambu-avatar')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('keeps every control reachable by keyboard', () => {
    const { shadow } = mount();

    for (const button of buttons(shadow)) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the shipped stylesheet honours §19 and §39', () => {
  it('respects prefers-reduced-motion', () => {
    expect(CSS).toContain('prefers-reduced-motion');
  });

  it('shows a visible focus ring', () => {
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toContain('outline');
  });

  it('is compact and corner-anchored, never full-screen (decision D68)', () => {
    expect(CSS).toContain('width: 320px');
    expect(CSS).toContain('position: fixed');
    expect(CSS).toContain('right: 16px');
    expect(CSS).toContain('bottom: 16px');

    // Nothing that would cover the page.
    expect(CSS).not.toMatch(/width:\s*100%/);
    expect(CSS).not.toMatch(/height:\s*100(%|vh)/);
    expect(CSS).not.toMatch(/inset:\s*0/);
  });

  it('uses no alarm colouring (CLAUDE.md §39)', () => {
    // Warm neutrals only. Matched as colour values, not substrings: the word
    // "red" also lives inside "prefers-reduced-motion".
    const lower = CSS.toLowerCase();
    expect(lower).not.toMatch(/:\s*(red|crimson|firebrick|tomato)\b/);
    expect(lower).not.toMatch(/#(f00|ff0000|e11d48|dc2626)\b/);
  });
});
