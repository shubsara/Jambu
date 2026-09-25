/**
 * Learning the working day (CLAUDE.md §16, decision D84).
 *
 * One observation per local day: when work first started and when it last
 * ended. The median of each across days gives the shape of a normal day
 * without one late night redefining it.
 *
 * The learned end matters beyond reporting — decision D7's end-of-day rule
 * fires only after the *learned* work end, so until this exists that
 * intervention cannot happen at all.
 */
import { confidenceFor, hasEnoughObservations } from './confidence.js';
import {
  groupByLocalDay,
  median,
  type LearnedWindow,
  type LocalRun,
} from './observations.js';

export interface LearnedWorkHours {
  readonly start: LearnedWindow;
  readonly end: LearnedWindow;
}

/** First start and last end for each local day that has any work at all. */
export function workDayObservations(runs: readonly LocalRun[]): {
  starts: number[];
  ends: number[];
} {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const dayRuns of groupByLocalDay(runs).values()) {
    const first = dayRuns[0];
    if (first === undefined) {
      continue;
    }
    starts.push(first.startMinute);
    ends.push(Math.max(...dayRuns.map((run) => run.endMinute)));
  }

  return { starts, ends };
}

/**
 * Learn work start and end, or `null` below the observation threshold.
 *
 * Both are returned as degenerate windows (start === end) so the shape matches
 * the other learned patterns; the caller stores each as its own row.
 */
export function learnWorkHours(runs: readonly LocalRun[]): LearnedWorkHours | null {
  const { starts, ends } = workDayObservations(runs);

  if (!hasEnoughObservations(starts.length)) {
    return null;
  }

  const startMedian = median(starts);
  const endMedian = median(ends);
  if (startMedian === null || endMedian === null) {
    return null;
  }

  const confidence = confidenceFor(starts.length);
  const point = (minute: number): LearnedWindow => ({
    startMinute: Math.round(minute),
    endMinute: Math.round(minute),
    confidence,
    sampleCount: starts.length,
  });

  return { start: point(startMedian), end: point(endMedian) };
}
