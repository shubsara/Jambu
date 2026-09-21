/**
 * Pause state (decision D5).
 *
 * CLAUDE.md §14 scores "User paused Jambu -100" and §42 requires a pause
 * control, but the §22 schema had nowhere to record it. Pause is a separate
 * concern from {@link UserPreferences} and has its own table.
 * See docs/ARCHITECTURE.md §11.6.
 */

import type { IsoTimestamp } from './time.js';

export interface PauseState {
  readonly paused: boolean;
  readonly pausedAt?: IsoTimestamp;
  /**
   * When the pause lifts. `null` while paused means paused indefinitely —
   * deliberately distinct from the field being absent, which means the user is
   * not paused at all.
   */
  readonly pausedUntil?: IsoTimestamp | null;
}
