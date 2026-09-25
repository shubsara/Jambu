/**
 * User preferences (CLAUDE.md §22).
 *
 * Stable user choices only. Pause and snooze are transient state and live in
 * their own types — see {@link PauseState} and {@link InterventionSnooze}
 * (decision D5).
 */

import type { IanaTimeZone, IsoTimestamp, TimeOfDay } from './time.js';

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

/**
 * What `GET`/`PUT /api/preferences` return (docs/API.md §6).
 *
 * Deliberately a superset of {@link UserPreferences} rather than a widening of
 * it. The Care Engine receives `UserPreferences` and has no business knowing
 * the user's timezone (it is given already-converted values — §13) or whether
 * they finished onboarding. Keeping the wire shape separate is what stops
 * either fact leaking into a scoring decision.
 */
export interface PreferencesView extends UserPreferences {
  /**
   * Decision D90 — the user's IANA timezone, settable through
   * `PUT /api/preferences`. Stored on `users.timezone`, not on the preferences
   * row, but surfaced here because this is the only endpoint that can change
   * it (docs/ARCHITECTURE.md §13).
   */
  readonly timezone: IanaTimeZone;
  /**
   * Resolution A1 — when onboarding was completed, or `null` if it has not
   * been. D93 gates activity tracking on this, and the extension has no other
   * way to learn it after a reinstall.
   */
  readonly onboardingCompletedAt: IsoTimestamp | null;
}

/**
 * What onboarding is allowed to send (decisions D88, D89; constraint 2).
 *
 * This type is the **primary** §3.2 guard, not a rendered-text scan: there is
 * no field here for a lunch time, a water schedule, a break schedule or work
 * hours, so onboarding cannot ask for one and have it go anywhere. Work hours
 * keep the 09:00-18:00 registration defaults (D91) until P11 learning
 * supersedes them (D84), and `persona` is never chosen by the user (D10).
 */
export interface OnboardingSubmission {
  readonly timezone: IanaTimeZone;
  readonly lunchEnabled: boolean;
  readonly breakEnabled: boolean;
  /** Opt-in and off unless the user turned it on (D7, D89). */
  readonly hydrationEnabled: boolean;
  readonly endDayEnabled: boolean;
  /** Resolution A2 — completion is explicit, never inferred. */
  readonly onboardingCompleted: true;
}
