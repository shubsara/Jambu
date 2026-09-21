/**
 * User preferences (CLAUDE.md §22).
 *
 * Stable user choices only. Pause and snooze are transient state and live in
 * their own types — see {@link PauseState} and {@link InterventionSnooze}
 * (decision D5).
 */

import type { TimeOfDay } from './time.js';

/**
 * Which persona speaks to the user (decision D10).
 *
 * MVP ships exactly one, `mom`. This is a plain identifier rather than a union
 * so the Care Engine never needs to know which personas exist; the registry in
 * `@jambu/message-templates` is the single place that resolves it.
 * See docs/ARCHITECTURE.md §8.
 */
export type PersonaId = string;

/** The default persona for a new user (decision D10). */
export const DEFAULT_PERSONA_ID = 'mom';

export interface UserPreferences {
  /** Approximate start of the working day, in the user's local time. */
  readonly workStart: TimeOfDay;
  /** Approximate end of the working day, in the user's local time. */
  readonly workEnd: TimeOfDay;
  readonly lunchEnabled: boolean;
  readonly breakEnabled: boolean;
  /**
   * Decision D7 — hydration is opt-in and defaults to `false`. Jambu asks
   * whether the user has had water; it never asserts a physical state.
   */
  readonly hydrationEnabled: boolean;
  readonly endDayEnabled: boolean;
  readonly persona: PersonaId;
}
