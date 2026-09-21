/**
 * Type qualification gates (docs/ARCHITECTURE.md §7.3).
 *
 * A gate answers "could this type sensibly apply right now?". Scoring then
 * answers "strongly enough to interrupt?". Keeping them separate is what
 * makes CLAUDE.md §15 enforceable: a context that is merely the right time of
 * day fails the gate before any score is computed.
 */
import type { CareContext } from '@jambu/shared-types';

import { RULE_THRESHOLDS } from '../config/scoring.js';
import { isLunchWindowActive } from '../predicates.js';

const MS_PER_MINUTE = 60_000;

/** Whether the type qualifies at all, and why not when it does not. */
export interface Qualification {
  readonly qualifies: boolean;
  readonly reason: string;
}

const no = (reason: string): Qualification => ({ qualifies: false, reason });
const yes = (reason: string): Qualification => ({ qualifies: true, reason });

/**
 * Lunch (decisions D8, D32).
 *
 * Requires a lunch window, significant continuous activity, the user active,
 * and no confirmation already today — never the clock alone (§15).
 */
export function qualifiesForLunch(context: CareContext): Qualification {
  if (!context.preferences.lunchEnabled) {
    return no('lunch reminders are disabled');
  }
  if (!isLunchWindowActive(context)) {
    return no('outside the lunch window');
  }
  if (context.currentActivity !== 'active') {
    return no('user is not currently active');
  }
  if (context.continuousWorkMinutes < RULE_THRESHOLDS.lunchMinContinuousMinutes) {
    return no('not enough continuous activity to suggest a missed lunch');
  }
  return yes('in the lunch window with sustained activity');
}

/**
 * Break (decision D33).
 *
 * Continuous work beyond the learned break interval, or beyond the default
 * threshold until routine learning has something to say.
 */
export function qualifiesForBreak(context: CareContext): Qualification {
  if (!context.preferences.breakEnabled) {
    return no('break reminders are disabled');
  }
  if (context.currentActivity !== 'active') {
    return no('user is not currently active');
  }

  const threshold =
    context.breakPattern?.averageIntervalMinutes ??
    RULE_THRESHOLDS.breakDefaultContinuousMinutes;

  if (context.continuousWorkMinutes < threshold) {
    return no('continuous work has not reached the break interval');
  }
  return yes('continuous work has passed the break interval');
}

/**
 * Hydration (decision D34) — deliberately conservative.
 *
 * Opt-in only, and silent after a recent confirmation. Jambu asks whether the
 * user has had water; it never asserts a physical state (§40).
 */
export function qualifiesForHydration(context: CareContext): Qualification {
  if (!context.preferences.hydrationEnabled) {
    return no('hydration reminders are not opted in');
  }
  if (context.currentActivity !== 'active') {
    return no('user is not currently active');
  }
  if (context.continuousWorkMinutes < RULE_THRESHOLDS.hydrationMinContinuousMinutes) {
    return no('not enough continuous activity');
  }

  const confirmation = context.lastHydrationConfirmation;
  if (confirmation !== undefined) {
    const minutesAgo =
      (context.currentTime.getTime() - confirmation.getTime()) / MS_PER_MINUTE;
    if (minutesAgo < RULE_THRESHOLDS.hydrationConfirmationWindowMinutes) {
      return no('hydration was confirmed recently');
    }
  }

  return yes('sustained activity with no recent hydration confirmation');
}

/**
 * End of day (decision D7).
 *
 * Fires only once the user has kept working well past the learned work end —
 * not merely because the clock passed it.
 */
export function qualifiesForEndOfDay(context: CareContext): Qualification {
  if (!context.preferences.endDayEnabled) {
    return no('end-of-day reminders are disabled');
  }
  if (context.currentActivity !== 'active') {
    return no('user is not currently active');
  }

  const workHours = context.workHours;
  if (workHours === undefined) {
    return no('no learned work end to measure against');
  }

  const minutesBeyond =
    (context.currentTime.getTime() - workHours.end.getTime()) / MS_PER_MINUTE;

  if (minutesBeyond < RULE_THRESHOLDS.endOfDayMinutesBeyondWorkEnd) {
    return no('not yet far enough past the work end');
  }
  return yes('still working well past the usual end of the day');
}
