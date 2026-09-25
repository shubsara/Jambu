/**
 * Learning the lunch window (CLAUDE.md §16, decisions D78, D82).
 *
 * Decision D78: an observation is a **midday gap between work runs**, not a
 * confirmed lunch intervention. Confirmations would be more accurate but only
 * exist once the feature already works — a cold start that would leave the
 * window permanently at its default.
 *
 * The median is what makes this robust. §16 requires that outliers not
 * radically shift the pattern, and a mean would let one 16:00 lunch drag the
 * whole window across the afternoon.
 */
import {
  median,
  groupByLocalDay,
  type LearnedWindow,
  type LocalRun,
} from './observations.js';
import { confidenceFor, hasEnoughObservations } from './confidence.js';

/**
 * Where to look for a lunch gap, in minutes from local midnight.
 *
 * A gap at 09:00 is someone arriving late; a gap at 17:00 is someone going
 * home. Neither is lunch. Not specified by CLAUDE.md — an implementation
 * choice, recorded in the P11 report.
 */
export const MIDDAY_SEARCH_START_MINUTE = 11 * 60;
export const MIDDAY_SEARCH_END_MINUTE = 15 * 60;

/** A gap shorter than this is a coffee refill, not a meal. */
export const MIN_LUNCH_GAP_MINUTES = 15;

/**
 * Half-width of the learned window around the median.
 *
 * Chosen so §16's worked example reproduces exactly: observations of
 * 13:20 / 13:42 / 13:35 / 13:29 / 13:38 have a median of 13:35, giving
 * 13:25-13:45.
 */
export const LUNCH_WINDOW_HALF_WIDTH_MINUTES = 10;

/**
 * The minute each day's lunch gap began.
 *
 * At most one observation per day: someone eats lunch once, and counting two
 * gaps from a fragmented afternoon would inflate confidence without adding
 * evidence.
 */
export function lunchObservations(runs: readonly LocalRun[]): number[] {
  const observations: number[] = [];

  for (const dayRuns of groupByLocalDay(runs).values()) {
    let best: { startMinute: number; gapMinutes: number } | null = null;

    for (let index = 0; index < dayRuns.length - 1; index += 1) {
      const gapStart = (dayRuns[index] as LocalRun).endMinute;
      const gapEnd = (dayRuns[index + 1] as LocalRun).startMinute;
      const gapMinutes = gapEnd - gapStart;

      if (gapMinutes < MIN_LUNCH_GAP_MINUTES) {
        continue;
      }
      if (gapStart < MIDDAY_SEARCH_START_MINUTE || gapStart > MIDDAY_SEARCH_END_MINUTE) {
        continue;
      }
      // The longest midday gap is the likeliest meal.
      if (best === null || gapMinutes > best.gapMinutes) {
        best = { startMinute: gapStart, gapMinutes };
      }
    }

    if (best !== null) {
      observations.push(best.startMinute);
    }
  }

  return observations;
}

/**
 * Learn a lunch window, or `null` when there is not enough evidence.
 *
 * `null` is the important case: CLAUDE.md §16 forbids personalizing below
 * three observations, and the caller keeps the D8 default with
 * `source: "default"` rather than inventing a pattern.
 */
export function learnLunchWindow(runs: readonly LocalRun[]): LearnedWindow | null {
  const observations = lunchObservations(runs);

  if (!hasEnoughObservations(observations.length)) {
    return null;
  }

  const centre = median(observations);
  if (centre === null) {
    return null;
  }

  return {
    startMinute: Math.round(centre) - LUNCH_WINDOW_HALF_WIDTH_MINUTES,
    endMinute: Math.round(centre) + LUNCH_WINDOW_HALF_WIDTH_MINUTES,
    confidence: confidenceFor(observations.length),
    sampleCount: observations.length,
  };
}
