/**
 * What routine learning is allowed to see.
 *
 * Deliberately narrow: a run of work, reduced to the local day it happened on
 * and the minutes it spanned. **No domain, no URL, no identifier, no raw
 * timestamp.** Jambu learns *when* someone works, never *what* they work on
 * (CLAUDE.md §9).
 *
 * Local minutes rather than instants keeps this package pure: converting a UTC
 * instant to a local wall-clock time needs a timezone database, and the caller
 * does that once in `apps/api/src/lib/timezone.ts` before handing observations
 * over.
 */

/** A stretch of continuous work, expressed in the user's local day. */
export interface LocalRun {
  /** `YYYY-MM-DD` in the user's local timezone. */
  readonly localDay: string;
  /** Minutes from local midnight when the run began. */
  readonly startMinute: number;
  /** Minutes from local midnight when the run ended. */
  readonly endMinute: number;
}

/** A learned time-of-day window. */
export interface LearnedWindow {
  /** Minutes from local midnight. */
  readonly startMinute: number;
  readonly endMinute: number;
  readonly confidence: number;
  readonly sampleCount: number;
}

/** A learned duration, such as how long someone works before a break. */
export interface LearnedInterval {
  readonly intervalMinutes: number;
  readonly confidence: number;
  readonly sampleCount: number;
}

/** Minutes from local midnight, rendered as `HH:mm`. */
export function toTimeOfDay(minuteOfDay: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minuteOfDay)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * The median of a list of numbers.
 *
 * CLAUDE.md §16 asks for robust statistics, and this is why: a single day
 * where someone ate at 16:00 should nudge the learned window, not relocate it.
 * A mean would let one outlier drag the answer anywhere.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Group runs by the local day they belong to, in chronological order. */
export function groupByLocalDay(runs: readonly LocalRun[]): Map<string, LocalRun[]> {
  const days = new Map<string, LocalRun[]>();

  for (const run of runs) {
    const existing = days.get(run.localDay);
    if (existing === undefined) {
      days.set(run.localDay, [run]);
    } else {
      existing.push(run);
    }
  }

  for (const dayRuns of days.values()) {
    dayRuns.sort((a, b) => a.startMinute - b.startMinute);
  }
  return days;
}
