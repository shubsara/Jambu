/**
 * Analytics emission, extension side (CLAUDE.md §29, decision D112).
 *
 * The same provider-agnostic contract as the API's `lib/analytics.ts`: no
 * provider is chosen, and with no sink installed this is a **no-op**. The
 * event *contract* is shared (`@jambu/shared-types`) so the two halves of a
 * funnel stay comparable; only the emission is per-app (CLAUDE.md §32).
 *
 * **Non-blocking** and **fail-open**, for a sharper reason than on the server.
 * These call sites are the activity tracker and the onboarding page - the care
 * loop itself. An analytics call that threw, or that a caller awaited, could
 * cost a user their session boundary. `emit` therefore returns `void` and
 * never throws.
 *
 * MV3 note: no timer is used. `setTimeout`/`setInterval` are lint-banned in
 * the background, and deferring work in a worker that may be terminated within
 * ~30s would simply lose it.
 */
import { findPrivacyViolations, type AnalyticsEvent } from '@jambu/shared-types';

import { readProfile } from './storage.js';

export type AnalyticsSink = (event: AnalyticsEvent) => void | Promise<void>;

/**
 * `Omit` over a union collapses it to the keys every member shares, which
 * would silently drop `activeSeconds` from the activity event. Distributing
 * over the union first keeps each shape intact.
 */
type WithoutUserId<T> = T extends unknown ? Omit<T, 'userId'> : never;

/** Any §29 event minus its `userId`, which {@link emitForCurrentUser} fills. */
export type AnalyticsEventDraft = WithoutUserId<AnalyticsEvent>;

/** The installed sink, or `null` for "no provider configured" (D112). */
let sink: AnalyticsSink | null = null;

/** Install a sink. Passing `null` returns the module to its no-op default. */
export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

/**
 * Emit one §29 event.
 *
 * Returns `void` so a caller physically cannot await it.
 */
export function emit(event: AnalyticsEvent): void {
  try {
    if (sink === null) {
      return;
    }
    if (findPrivacyViolations(event).length > 0) {
      // Fail closed on privacy (ARCHITECTURE.md §10).
      return;
    }

    const result = sink(event);
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  } catch {
    // Fail open: measurement never breaks the care loop.
  }
}

/**
 * Emit an event, resolving `userId` from the stored profile.
 *
 * The resolution is asynchronous but the call is not: reading
 * `chrome.storage` on the activity path would otherwise put a storage round
 * trip between a tab event and the session boundary it produces.
 *
 * A missing profile yields `userId: null`, which is correct rather than
 * defensive - `onboarding_started` fires before the account exists (D114), and
 * decision D113 forbids inventing an anonymous id to fill the gap.
 *
 * `StoredProfile.email` is never read here. Only `id` is.
 */
export function emitForCurrentUser(event: AnalyticsEventDraft): void {
  try {
    void (async () => {
      try {
        const profile = await readProfile();
        emit({ ...event, userId: profile?.id ?? null } as AnalyticsEvent);
      } catch {
        // A storage failure must not surface on the care path either.
      }
    })();
  } catch {
    // Fail open.
  }
}

/** Exposed for tests; clears the installed sink between cases. */
export function __resetAnalytics(): void {
  sink = null;
}
