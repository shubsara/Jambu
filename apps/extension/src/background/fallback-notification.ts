/**
 * Native notification fallback (decision D67, ARCHITECTURE.md §9.2).
 *
 * Used when no injectable tab exists — a `chrome://` page, the Web Store, a
 * PDF, or no focused window. It cannot carry the CLAUDE.md §19 design, which
 * is exactly why it is the fallback and not the default.
 *
 * A native notification offers no way to answer, so the intervention stays
 * unanswered and expires server-side (decision D69).
 */
import type { CardContent } from '../content/care-card/card.js';

export async function showFallbackNotification(
  content: CardContent,
  notifications = globalThis.chrome?.notifications,
): Promise<boolean> {
  if (notifications?.create === undefined) {
    return false;
  }

  try {
    await notifications.create(`jambu:${content.interventionId}`, {
      type: 'basic',
      iconUrl: 'icons/jambu-128.png',
      title: content.greeting,
      message: content.message,
      // Quiet by design: this must not demand attention the card would not.
      silent: true,
      priority: 0,
    });
    return true;
  } catch {
    // The OS may suppress notifications entirely. Nothing to recover.
    return false;
  }
}
