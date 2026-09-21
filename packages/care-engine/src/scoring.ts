/**
 * Scoring (CLAUDE.md §14, decision D37).
 *
 * One reusable model across all intervention types. Every weight comes from
 * `config/scoring.ts`, which reproduces §14 exactly — no weight is invented
 * here to make a type reach the threshold.
 *
 * Pure: no clock, no randomness, no I/O. `context.currentTime` is the only
 * notion of "now".
 */
import type { CareContext, InterventionType } from '@jambu/shared-types';

import { RULE_THRESHOLDS, SCORING_WEIGHTS } from './config/scoring.js';
import { isLunchWindowActive, isOutsideWorkPeriod } from './predicates.js';
import { qualifiesForEndOfDay, qualifiesForHydration } from './rules/index.js';

/** One applied signal, kept so the decision can explain itself (§13). */
export interface ScoreSignal {
  readonly name: string;
  readonly points: number;
}

export interface ScoreBreakdown {
  readonly score: number;
  readonly signals: readonly ScoreSignal[];
}

const MS_PER_MINUTE = 60_000;

function minutesSince(now: Date, past: Date | undefined): number | undefined {
  return past === undefined
    ? undefined
    : (now.getTime() - past.getTime()) / MS_PER_MINUTE;
}

/**
 * Score a candidate intervention type against the context.
 *
 * The returned signals are the arithmetic, in the order applied, so
 * `reason` can state exactly why a decision came out as it did.
 */
export function scoreFor(context: CareContext, type: InterventionType): ScoreBreakdown {
  const signals: ScoreSignal[] = [];
  const add = (name: string, points: number): void => {
    signals.push({ name, points });
  };

  // --- positive signals ----------------------------------------------------
  if (type === 'lunch' && isLunchWindowActive(context)) {
    add('lunch window active', SCORING_WEIGHTS.lunchWindowActive);
  }

  // Decision D41. The bonus is earned only by passing the type's own
  // eligibility gate, so it can never turn a clock-only context into an
  // intervention — the gate has already required sustained activity.
  if (type === 'hydration' && qualifiesForHydration(context).qualifies) {
    add('hydration eligibility gate passed', SCORING_WEIGHTS.hydrationGatePassed);
  }
  if (type === 'end_of_day' && qualifiesForEndOfDay(context).qualifies) {
    add('end-of-day eligibility gate passed', SCORING_WEIGHTS.endOfDayGatePassed);
  }

  if (context.continuousWorkMinutes > RULE_THRESHOLDS.continuousWorkTier1Minutes) {
    add('continuous work over 120 minutes', SCORING_WEIGHTS.continuousWorkOver120);
  }
  if (context.continuousWorkMinutes > RULE_THRESHOLDS.continuousWorkTier2Minutes) {
    add('continuous work over 180 minutes', SCORING_WEIGHTS.continuousWorkOver180);
  }

  if (hasHistoricalConfidence(context, type)) {
    add('historical pattern confidence', SCORING_WEIGHTS.historicalPatternConfidence);
  }

  if (context.currentActivity === 'active') {
    add('user currently active', SCORING_WEIGHTS.userCurrentlyActive);
  }

  // --- negative signals ----------------------------------------------------
  const sinceIntervention = minutesSince(context.currentTime, context.lastIntervention);
  if (
    sinceIntervention !== undefined &&
    sinceIntervention < RULE_THRESHOLDS.recentInterventionMinutes
  ) {
    add('recent intervention', SCORING_WEIGHTS.recentIntervention);
  } else {
    add('no recent intervention', SCORING_WEIGHTS.noRecentIntervention);
  }

  const sinceDismissal = minutesSince(
    context.currentTime,
    context.lastDismissalByType?.[type],
  );
  if (
    sinceDismissal !== undefined &&
    sinceDismissal < RULE_THRESHOLDS.recentDismissalMinutes
  ) {
    add('recent dismissal', SCORING_WEIGHTS.recentDismissal);
  }

  const snoozedUntil = context.snoozedUntilByType?.[type];
  if (
    snoozedUntil !== undefined &&
    snoozedUntil.getTime() > context.currentTime.getTime()
  ) {
    add('recent snooze', SCORING_WEIGHTS.recentSnooze);
  }

  if (isOutsideWorkPeriod(context)) {
    add('outside normal work period', SCORING_WEIGHTS.outsideWorkPeriod);
  }

  if (context.isPaused) {
    add('user paused Jambu', SCORING_WEIGHTS.userPaused);
  }

  return {
    score: signals.reduce((total, signal) => total + signal.points, 0),
    signals,
  };
}

/**
 * Whether a learned pattern backs this type.
 *
 * Confidence must be above zero: decision D8 gives the default lunch window
 * confidence `0` precisely so a fallback can never be mistaken for a learned
 * pattern and earn the historical-confidence bonus.
 */
function hasHistoricalConfidence(context: CareContext, type: InterventionType): boolean {
  if (type === 'lunch') {
    return (context.lunchWindow?.confidence ?? 0) > 0;
  }
  if (type === 'break') {
    return (context.breakPattern?.confidence ?? 0) > 0;
  }
  // End-of-day and hydration do not earn this term. The approved D41
  // arithmetic puts their maxima at 75 and 85, which holds only if the
  // historical-confidence bonus is not also applied: end-of-day's learned
  // work end is already what its own +40 gate signal rewards.
  return false;
}

export { isLunchWindowActive, isOutsideWorkPeriod } from './predicates.js';
