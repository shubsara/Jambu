/**
 * Idle detection (decision D62, CLAUDE.md §11).
 *
 * `chrome.idle` is the only API that reports OS-level inactivity, which is why
 * ARCHITECTURE.md §9.3 asks for the permission.
 *
 * The 60-second detection threshold is **not** D6's continuity rule. D6 says a
 * gap of >=10 minutes ends a stretch of continuous work, and that stays
 * authoritative in P5 derivation, which folds the stored sessions into runs.
 * Detection here only decides when to close a session; how those sessions
 * combine is decided once, elsewhere.
 */
import { closeSession } from './activity-tracker.js';
import { mayTrack } from './tracking-gate.js';

/** Decision D62. `chrome.idle` requires at least 15 seconds. */
export const IDLE_DETECTION_SECONDS = 60;

/**
 * Handle an idle state change.
 *
 * `locked` counts as idle: a locked laptop is not someone working. Returning
 * to `active` does not open a session here — the tab listeners do that, since
 * only they know the domain.
 */
export type IdleState = 'active' | 'idle' | 'locked';

export async function handleIdleStateChange(
  state: IdleState,
  now: Date,
): Promise<boolean> {
  if (state === 'active') {
    return false;
  }
  // Decision D93 — with tracking gated there is no open session to close.
  if (!(await mayTrack())) {
    return false;
  }
  return closeSession(now);
}

export function registerIdleListeners(idle = globalThis.chrome?.idle): void {
  if (idle === undefined) {
    return;
  }
  idle.setDetectionInterval?.(IDLE_DETECTION_SECONDS);
  idle.onStateChanged?.addListener((state) => {
    void handleIdleStateChange(state, new Date());
  });
}
