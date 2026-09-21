/**
 * Shared pure predicates.
 *
 * Extracted so both the rule gates and the scoring model can use them without
 * importing each other. No clock, no I/O: `context.currentTime` is the only
 * notion of "now".
 */
import type { CareContext } from '@jambu/shared-types';

/** Whether the current instant falls inside the lunch window. */
export function isLunchWindowActive(context: CareContext): boolean {
  const window = context.lunchWindow;
  if (window === undefined) {
    return false;
  }
  const now = context.currentTime.getTime();
  return now >= window.start.getTime() && now <= window.end.getTime();
}

/**
 * Whether the instant falls outside the working day.
 *
 * Decision D39: work hours arrive already resolved by the caller, because
 * converting a local `HH:mm` needs a timezone database the engine must not
 * reach for.
 *
 * With no resolved work hours no penalty applies — asserting the user is
 * outside their working day on no evidence would be exactly the clock-only
 * guess CLAUDE.md §15 warns against.
 */
export function isOutsideWorkPeriod(context: CareContext): boolean {
  const hours = context.workHours;
  if (hours === undefined) {
    return false;
  }
  const now = context.currentTime.getTime();
  return now < hours.start.getTime() || now > hours.end.getTime();
}
