/**
 * Analytics emission, API side (CLAUDE.md §29, decision D112).
 *
 * Provider-agnostic on purpose. P14 states "Database changes. None." and "API
 * changes. None.", so there is no events table and no ingest endpoint, and no
 * provider is chosen here - choosing one is a decision the repository has not
 * made. With no sink installed this is a **no-op**, which is the specified
 * behaviour for absent configuration, not a placeholder.
 *
 * Two properties matter more than delivery:
 *
 *  - **Non-blocking.** `emit` returns `void`, so a caller physically cannot
 *    await it. A slow sink cannot delay a care decision.
 *  - **Fail-open.** Nothing here throws. A sink that explodes, a payload that
 *    is malformed, a rejected promise - all are swallowed. CLAUDE.md §43 wants
 *    a reliable care loop, and measurement is never worth breaking it for.
 *
 * Privacy fails *closed*: a payload that violates ARCHITECTURE.md §10 is
 * dropped rather than sent. Dropping telemetry is harmless; leaking a domain
 * or an email is not.
 */
import { findPrivacyViolations, type AnalyticsEvent } from '@jambu/shared-types';

export type AnalyticsSink = (event: AnalyticsEvent) => void | Promise<void>;

/**
 * The installed sink, or `null` for "no provider configured" (D112).
 *
 * Module scope is adequate: the API is a single long-lived process, and
 * nothing durable depends on this.
 */
let sink: AnalyticsSink | null = null;

/** Install a sink. Passing `null` returns the module to its no-op default. */
export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

/**
 * Emit one §29 event.
 *
 * Deliberately returns `void` rather than a promise: that is what makes
 * "non-blocking" a property of the signature instead of a convention callers
 * have to remember.
 */
export function emit(event: AnalyticsEvent): void {
  try {
    if (sink === null) {
      return;
    }
    if (findPrivacyViolations(event).length > 0) {
      // Fail closed on privacy. No log line either: the payload is exactly
      // what we have just decided is unsafe to record.
      return;
    }

    const result = sink(event);
    if (result instanceof Promise) {
      // Not awaited - see the module comment. The catch is what stops an
      // unhandled rejection from reaching the process.
      result.catch(() => undefined);
    }
  } catch {
    // Fail open (P14: "analytics failure never breaks the care loop").
  }
}

/** Exposed for tests; clears the installed sink between cases. */
export function __resetAnalytics(): void {
  sink = null;
}
