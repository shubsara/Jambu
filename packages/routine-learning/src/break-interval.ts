/**
 * Learning how long someone works before stopping (CLAUDE.md §16).
 *
 * The observation is the length of a work run. The Care Engine uses the result
 * as `breakPattern.averageIntervalMinutes` and suggests a break once continuous
 * work passes it, so this is literally "how long this person tends to go".
 *
 * Decision D77: the result is a **duration**, stored in `interval_minutes`.
 * P7 previously inferred it from a time span, which could not express an
 * interval of a day or more and misrepresented what those columns mean.
 */
import { confidenceFor, hasEnoughObservations } from './confidence.js';
import { median, type LearnedInterval, type LocalRun } from './observations.js';

/**
 * Runs shorter than this are noise — a glance at a tab, not a stretch of work.
 * Not specified by CLAUDE.md; an implementation choice recorded in the report.
 */
export const MIN_RUN_MINUTES_FOR_BREAK_LEARNING = 10;

export function runLengths(runs: readonly LocalRun[]): number[] {
  return runs
    .map((run) => run.endMinute - run.startMinute)
    .filter((length) => length >= MIN_RUN_MINUTES_FOR_BREAK_LEARNING);
}

/** Learn a break interval, or `null` below the observation threshold. */
export function learnBreakInterval(runs: readonly LocalRun[]): LearnedInterval | null {
  const lengths = runLengths(runs);

  if (!hasEnoughObservations(lengths.length)) {
    return null;
  }

  const typical = median(lengths);
  if (typical === null || typical <= 0) {
    return null;
  }

  return {
    intervalMinutes: Math.round(typical),
    confidence: confidenceFor(lengths.length),
    sampleCount: lengths.length,
  };
}
