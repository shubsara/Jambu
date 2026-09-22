/**
 * Care Card orchestration (ARCHITECTURE.md §9, decisions D67, D72, D74).
 *
 * This is the last link in the chain: activity is observed (P9), ingested
 * (P4), derived (P5), decided on (P6) and persisted (P7) — and here it finally
 * reaches the person.
 *
 * Delivery is one attempt in one place: the active tab of the focused window.
 * If that fails, a native notification. It never hunts for another tab
 * (decision D67) — a card on a page the user is not looking at is worse than
 * no card at all.
 */
import { getPersona } from '@jambu/message-templates';
import type { InterventionType } from '@jambu/shared-types';

import type { CardContent } from '../content/care-card/card.js';
import { showFallbackNotification } from './fallback-notification.js';
import { hasBeenShown, markShown } from './shown-registry.js';

/** The intervention as the API returns it (docs/API.md §8). */
export interface PendingIntervention {
  readonly id: string;
  readonly type: InterventionType;
  readonly persona: string;
  readonly message: string;
  readonly expiresAt: string;
}

export type DeliveryResult = 'card' | 'notification' | 'suppressed' | 'failed';

const CONTENT_SCRIPT = 'content/care-card.js';
const CARD_STYLESHEET = 'content/care-card.css';

/**
 * Build what the card displays.
 *
 * The message text comes from the API, which rendered it through the persona
 * registry in P7. The surrounding furniture — avatar, greeting, signature,
 * button labels — comes from the same registry here, so the card never invents
 * words of its own (decision D10).
 */
export function buildCardContent(intervention: PendingIntervention): CardContent {
  const persona = getPersona(intervention.persona);

  return {
    interventionId: intervention.id,
    message: intervention.message,
    signature: persona.signature,
    avatar: '👩',
    greeting: 'Hey! ❤️',
    confirmLabel: 'Yes, I have',
    snoozeLabel: 'Remind me later',
  };
}

/** The extension reads its own stylesheet; the page never fetches it. */
async function readStylesheet(): Promise<string> {
  const url = globalThis.chrome?.runtime?.getURL?.(CARD_STYLESHEET);
  if (url === undefined) {
    return '';
  }
  const response = await fetch(url);
  return response.text();
}

/** The tab the user is actually looking at, or null (decision D67). */
async function focusedTab(
  tabsApi = globalThis.chrome?.tabs,
): Promise<chrome.tabs.Tab | null> {
  const tabs = await tabsApi?.query?.({ active: true, lastFocusedWindow: true });
  return tabs?.[0] ?? null;
}

/** Whether a page can host an injected script at all. */
function isInjectable(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Deliver an intervention.
 *
 * Returns how it was delivered, so callers and tests can tell a card from a
 * notification from a suppression without inspecting side effects.
 */
export async function deliver(
  intervention: PendingIntervention,
  now: Date,
): Promise<DeliveryResult> {
  // Decision D74: both D4 paths can surface the same intervention.
  if (await hasBeenShown(intervention.id, now)) {
    return 'suppressed';
  }

  const content = buildCardContent(intervention);
  const tab = await focusedTab();

  if (tab !== null && tab.id !== undefined && isInjectable(tab.url)) {
    try {
      await globalThis.chrome?.scripting?.executeScript?.({
        target: { tabId: tab.id },
        files: [CONTENT_SCRIPT],
      });

      const css = await readStylesheet();
      await globalThis.chrome?.tabs?.sendMessage?.(tab.id, {
        type: 'jambu:show-card',
        content,
        css,
      });

      await markShown(intervention.id, now);
      return 'card';
    } catch {
      // Injection can fail for reasons the URL does not reveal. Fall through
      // rather than leaving the user with nothing.
    }
  }

  const notified = await showFallbackNotification(content);
  if (notified) {
    await markShown(intervention.id, now);
    return 'notification';
  }

  return 'failed';
}

/** Deliver at most one intervention from a list (ARCHITECTURE.md §7.4). */
export async function deliverFirst(
  interventions: readonly PendingIntervention[],
  now: Date,
): Promise<DeliveryResult | null> {
  for (const intervention of interventions) {
    const result = await deliver(intervention, now);
    if (result !== 'suppressed') {
      return result;
    }
  }
  return null;
}

export { CONTENT_SCRIPT, CARD_STYLESHEET, isInjectable };
