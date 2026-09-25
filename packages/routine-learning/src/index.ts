/**
 * @jambu/routine-learning
 *
 * Turns observed work into the routines the Care Engine reasons over
 * (CLAUDE.md §16).
 *
 * Pure, like the Care Engine and for the same reasons: no clock, no
 * randomness, no database, no network. Observations arrive already reduced to
 * local days and local minutes, which keeps timezone handling in exactly one
 * place and makes every case here expressible as plain data.
 *
 * What it never sees: domains, URLs, page content or user identifiers. It
 * learns *when* someone works, never *what* they work on (CLAUDE.md §9).
 */
import { learnBreakInterval } from './break-interval.js';
import { learnLunchWindow } from './lunch.js';
import { learnWorkHours } from './work-hours.js';
import type { LearnedInterval, LearnedWindow, LocalRun } from './observations.js';

export {
  CONFIDENCE_BY_TIER,
  TIER_THRESHOLDS,
  confidenceFor,
  hasEnoughObservations,
  tierFor,
  type ConfidenceTier,
} from './confidence.js';
export {
  LUNCH_WINDOW_HALF_WIDTH_MINUTES,
  MIDDAY_SEARCH_END_MINUTE,
  MIDDAY_SEARCH_START_MINUTE,
  MIN_LUNCH_GAP_MINUTES,
  learnLunchWindow,
  lunchObservations,
} from './lunch.js';
export {
  MIN_RUN_MINUTES_FOR_BREAK_LEARNING,
  learnBreakInterval,
  runLengths,
} from './break-interval.js';
export {
  learnWorkHours,
  workDayObservations,
  type LearnedWorkHours,
} from './work-hours.js';
export {
  groupByLocalDay,
  median,
  toTimeOfDay,
  type LearnedInterval,
  type LearnedWindow,
  type LocalRun,
} from './observations.js';

/** Everything learnable from one user's observations. */
export interface LearnedRoutines {
  /** `null` means not enough evidence — keep the D8 default (§16). */
  readonly lunch: LearnedWindow | null;
  readonly workStart: LearnedWindow | null;
  readonly workEnd: LearnedWindow | null;
  readonly breakInterval: LearnedInterval | null;
}

/**
 * Learn every routine from a set of work runs.
 *
 * Deterministic: the same runs always produce the same routines.
 */
export function learnRoutines(runs: readonly LocalRun[]): LearnedRoutines {
  const workHours = learnWorkHours(runs);

  return {
    lunch: learnLunchWindow(runs),
    workStart: workHours?.start ?? null,
    workEnd: workHours?.end ?? null,
    breakInterval: learnBreakInterval(runs),
  };
}
