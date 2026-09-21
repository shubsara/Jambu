/**
 * Care Engine contract (CLAUDE.md §13).
 *
 * The Care Engine decides *whether* to intervene. The message layer decides
 * *how to say it* (CLAUDE.md §8). These types deliberately contain no message
 * text and no persona: the engine has no persona awareness at all, which is
 * what makes decision D10 true — adding a persona cannot require an engine
 * change. See docs/ARCHITECTURE.md §8.
 *
 * Purity (docs/ARCHITECTURE.md §3): the engine performs no I/O and never reads
 * the clock. `currentTime` is an input on {@link CareContext}, which is what
 * makes CLAUDE.md §27's test matrix — cooldown, snooze, dismissal, paused
 * user, DST boundaries — cheap to write and genuinely deterministic.
 */

import type { ActivityStatus } from './activity.js';
import type { InterventionType } from './intervention.js';
import type { UserPreferences } from './preferences.js';

/** A time window the engine reasons about, resolved to absolute instants. */
export interface CareWindow {
  readonly start: Date;
  readonly end: Date;
  /** 0–1. Zero means "default, nothing learned yet" (decision D8). */
  readonly confidence: number;
}

/** A learned break rhythm (CLAUDE.md §16). */
export interface BreakPattern {
  readonly averageIntervalMinutes: number;
  /** 0–1. */
  readonly confidence: number;
}

/**
 * The learned bounds of the working day, resolved to absolute instants for the
 * day being evaluated.
 *
 * Decision D7's end-of-day rule fires only after the *learned* work-end time,
 * which is why this is distinct from {@link UserPreferences.workEnd} — the
 * latter is what the user told us at onboarding, the former is what Jambu
 * observed. See docs/ARCHITECTURE.md §7.3.
 */
export interface WorkHours {
  readonly start: Date;
  readonly end: Date;
  /** 0–1. Zero means the preference is being used because nothing is learned. */
  readonly confidence: number;
}

/** A per-intervention-type map of instants, e.g. when each type was snoozed. */
export type InterventionTypeInstants = Readonly<Partial<Record<InterventionType, Date>>>;

/** A per-intervention-type map of counts, e.g. consecutive dismissals. */
export type InterventionTypeCounts = Readonly<Partial<Record<InterventionType, number>>>;

/**
 * Everything the Care Engine is allowed to know.
 *
 * Every field is supplied by the caller. The engine reads nothing else — no
 * clock, no database, no environment.
 */
export interface CareContext {
  /** The instant being evaluated. Never read from the system clock. */
  readonly currentTime: Date;

  /** Current active session only (decision D6). */
  readonly continuousWorkMinutes: number;
  readonly totalWorkMinutesToday: number;
  readonly currentActivity: ActivityStatus;

  readonly lunchWindow?: CareWindow;
  readonly breakPattern?: BreakPattern;
  /** Learned working hours, used by the D7 end-of-day rule. */
  readonly workHours?: WorkHours;

  readonly lastLunchConfirmation?: Date;
  /**
   * Decision D7 — hydration requires that the user has not already confirmed
   * drinking recently.
   */
  readonly lastHydrationConfirmation?: Date;
  readonly lastIntervention?: Date;

  /**
   * When each type was last dismissed. Backs the CLAUDE.md §14
   * "Recent dismissal -25" term.
   */
  readonly lastDismissalByType?: InterventionTypeInstants;
  /**
   * Consecutive dismissals per type. CLAUDE.md §17: repeated dismissal is a
   * signal to intervene *less*, never more.
   */
  readonly consecutiveDismissalsByType?: InterventionTypeCounts;
  /**
   * Active snoozes per type (decision D5). Snoozing lunch must not silence
   * breaks, which is why this is per type rather than a single instant.
   */
  readonly snoozedUntilByType?: InterventionTypeInstants;

  /**
   * Decision D5 — backs the CLAUDE.md §14 "User paused Jambu -100" term.
   * `pausedUntil` is absent when the pause is indefinite.
   */
  readonly isPaused: boolean;
  readonly pausedUntil?: Date;

  readonly preferences: UserPreferences;
}

/**
 * The engine's verdict (CLAUDE.md §13).
 *
 * `score` and `reason` are not optional: CLAUDE.md §13 requires the engine be
 * explainable, and the scoring weights in §14 are explicitly "starting points,
 * not permanent product truth" — they can only be tuned from real data if
 * every decision records the arithmetic that produced it.
 */
export interface CareDecision {
  readonly shouldIntervene: boolean;
  readonly interventionType: InterventionType | null;
  readonly score: number;
  readonly reason: string;
}
