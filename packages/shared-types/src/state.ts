/**
 * Derived user state (CLAUDE.md §12).
 *
 * Derived from stored activity and routine data on every request, never
 * duplicated into its own table (CLAUDE.md §12: "avoid storing unnecessary
 * duplicate state"). All day-based figures are computed in the user's local
 * day, never the UTC day (CLAUDE.md §28).
 */

import type { ActivityStatus } from './activity.js';
import type { IsoTimestamp } from './time.js';

/**
 * How much evidence a learned routine rests on (CLAUDE.md §16).
 *
 * `insufficient` (< 3 observations) means Jambu uses generic default
 * behaviour and does not personalize.
 */
export type RoutineConfidenceTier = 'insufficient' | 'low' | 'medium' | 'high';

/**
 * Where a lunch window came from (decision D8).
 *
 * This field exists so the 12:30–14:30 fallback can never be mistaken for a
 * learned pattern and quietly harden into a fixed schedule.
 */
export type LunchWindowSource = 'default' | 'learned';

export interface LunchWindow {
  readonly start: IsoTimestamp;
  readonly end: IsoTimestamp;
  /** 0–1. Always 0 when {@link source} is `default`. */
  readonly confidence: number;
  readonly source: LunchWindowSource;
}

export interface UserState {
  /**
   * Minutes of the *current* active session only (decision D6). An idle gap of
   * {@link IDLE_BREAK_THRESHOLD_MINUTES} minutes or more resets this to zero.
   */
  readonly continuousWorkMinutes: number;
  /** Total active minutes in the user's local day (CLAUDE.md §28). */
  readonly totalWorkMinutesToday: number;
  readonly lastBreakMinutesAgo?: number;
  readonly lunchWindow?: LunchWindow;
  readonly lastLunchConfirmation?: IsoTimestamp;
  readonly lastInterventionAt?: IsoTimestamp;
  readonly currentActivity: ActivityStatus;
  /** Decision D5 — surfaced here so the extension can reflect it in the UI. */
  readonly paused: boolean;
}
