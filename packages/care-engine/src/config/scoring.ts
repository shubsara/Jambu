/**
 * Scoring configuration.
 *
 * CLAUDE.md §14 calls these "starting points, not permanent product truth",
 * so every number the engine uses lives here — one editable object, no
 * literals scattered through the rules. Every intervention persists the score
 * and reason it produced, so tuning is driven by beta data (§13).
 */
import type { InterventionType } from '@jambu/shared-types';

/**
 * The §14 weights, reproduced exactly. No weight here was invented: each one
 * appears verbatim in CLAUDE.md §14.
 */
export const SCORING_WEIGHTS = {
  /** "Lunch window active +30" — a lunch-specific signal. */
  lunchWindowActive: 30,
  /** "Continuous work > 120 minutes +25" */
  continuousWorkOver120: 25,
  /** "Continuous work > 180 minutes +20" — cumulative with the tier above. */
  continuousWorkOver180: 20,
  /** "Historical pattern confidence +20" */
  historicalPatternConfidence: 20,
  /** "User currently active +10" */
  userCurrentlyActive: 10,
  /** "No recent intervention +10" */
  noRecentIntervention: 10,

  /**
   * Decision D41 — type-specific positive signals.
   *
   * CLAUDE.md §14 gives an explicit signal only to lunch, which left
   * hydration and end-of-day unable to reach the threshold at all. These two
   * weights were surfaced and approved before implementation; they are
   * scoring signals, never standalone triggers, and every existing rule gate
   * still has to pass first.
   */
  hydrationGatePassed: 20,
  endOfDayGatePassed: 40,

  /** "Recent intervention -20" */
  recentIntervention: -20,
  /** "Recent dismissal -25" */
  recentDismissal: -25,
  /** "Recent snooze -20" */
  recentSnooze: -20,
  /** "Outside normal work period -30" */
  outsideWorkPeriod: -30,
  /** "User paused Jambu -100" */
  userPaused: -100,
} as const;

/** §14 bands. 0–39 silent, 40–69 monitor, 70+ intervene. */
export const SCORE_THRESHOLDS = {
  monitor: 40,
  intervene: 70,
} as const;

/**
 * Gates each rule must pass before scoring is even considered.
 *
 * These are qualifying conditions, not weights: they encode CLAUDE.md §15's
 * rule that Jambu never reminds on the clock alone.
 */
export const RULE_THRESHOLDS = {
  /** Decision D32 — lunch needs significant continuous activity. */
  lunchMinContinuousMinutes: 45,
  /** Decision D33 — break threshold before routine learning exists. */
  breakDefaultContinuousMinutes: 90,
  /** Decision D34 — hydration needs meaningful continuous activity. */
  hydrationMinContinuousMinutes: 60,
  /** Decision D34 — and no hydration confirmation inside this window. */
  hydrationConfirmationWindowMinutes: 90,
  /** Decision D7 — end of day waits this long past the learned work end. */
  endOfDayMinutesBeyondWorkEnd: 30,

  /** §14 continuous-work tiers. */
  continuousWorkTier1Minutes: 120,
  continuousWorkTier2Minutes: 180,

  /** How recent counts as "recent" for the §14 penalty terms. */
  recentInterventionMinutes: 60,
  recentDismissalMinutes: 180,
} as const;

/**
 * Cooldowns (decisions D35, D36).
 *
 * §17: Jambu must not become annoying, and repeated dismissal is a signal to
 * speak *less*. The backoff below can only ever lengthen a cooldown.
 */
export const COOLDOWNS = {
  /** D35 — minimum gap between any two interventions, of any type. */
  globalMinutes: 60,
  /** D35 — minimum gap between two interventions of the same type. */
  perTypeMinutes: 180,
  /** D36 — base x 2^min(consecutiveDismissals, 3), capped here. */
  maxPerTypeMinutes: 1440,
  /** D36 — the exponent is clamped to this. */
  dismissalBackoffExponentCap: 3,
} as const;

/**
 * Tie-break order when several types qualify with the same score
 * (docs/ARCHITECTURE.md §7.4).
 */
export const TYPE_PRIORITY: readonly InterventionType[] = [
  'lunch',
  'end_of_day',
  'break',
  'hydration',
] as const;

/**
 * Which §14 signals apply to which intervention type.
 *
 * "Lunch window active" is explicitly a lunch signal; every other §14 term is
 * written type-neutrally and so applies to all types (decision D37).
 */
export const LUNCH_ONLY_SIGNALS = ['lunchWindowActive'] as const;
