/**
 * Cooldowns and suppression (CLAUDE.md §17, decisions D35, D36).
 *
 * §17: "Repeated dismissal is a signal. It should not be interpreted as a
 * reason to notify more aggressively." Every rule here can only ever make
 * Jambu quieter.
 *
 * Pure: `now` arrives on the context.
 */
import type { CareContext, InterventionType } from '@jambu/shared-types';

import { COOLDOWNS } from './config/scoring.js';

const MS_PER_MINUTE = 60_000;

/** Why an otherwise-qualifying intervention was suppressed. */
export type SuppressionReason =
  | 'user paused Jambu'
  | 'type is snoozed'
  | 'global cooldown active'
  | 'per-type cooldown active'
  | 'lunch already confirmed today';

/**
 * How long the per-type cooldown lasts, lengthened by repeated dismissal
 * (decision D36): base x 2^min(dismissals, 3), capped.
 *
 * Monotonic by construction — more dismissals can never shorten it.
 */
export function perTypeCooldownMinutes(consecutiveDismissals: number): number {
  const dismissals = Math.max(0, Math.floor(consecutiveDismissals));
  const exponent = Math.min(dismissals, COOLDOWNS.dismissalBackoffExponentCap);
  const scaled = COOLDOWNS.perTypeMinutes * 2 ** exponent;
  return Math.min(scaled, COOLDOWNS.maxPerTypeMinutes);
}

function minutesSince(now: Date, past: Date): number {
  return (now.getTime() - past.getTime()) / MS_PER_MINUTE;
}

/**
 * Whether lunch has already been confirmed for the current local day.
 *
 * The engine cannot compute a local day without a timezone database, which
 * decision D39 forbids it from reaching for. Today's lunch window is already
 * resolved to instants by the caller, so a confirmation at or after the start
 * of that window is a confirmation made today.
 */
function lunchConfirmedToday(context: CareContext): boolean {
  const confirmation = context.lastLunchConfirmation;
  const window = context.lunchWindow;
  if (confirmation === undefined || window === undefined) {
    return false;
  }
  return confirmation.getTime() >= window.start.getTime();
}

/**
 * Decide whether an intervention type is suppressed outright.
 *
 * Suppression is checked before scoring matters: a paused or snoozed user is
 * not asked how high the score was.
 */
export function suppressionFor(
  context: CareContext,
  type: InterventionType,
): SuppressionReason | null {
  if (context.isPaused) {
    return 'user paused Jambu';
  }

  const snoozedUntil = context.snoozedUntilByType?.[type];
  if (
    snoozedUntil !== undefined &&
    snoozedUntil.getTime() > context.currentTime.getTime()
  ) {
    return 'type is snoozed';
  }

  if (type === 'lunch' && lunchConfirmedToday(context)) {
    return 'lunch already confirmed today';
  }

  if (
    context.lastIntervention !== undefined &&
    minutesSince(context.currentTime, context.lastIntervention) < COOLDOWNS.globalMinutes
  ) {
    return 'global cooldown active';
  }

  const lastOfType = context.lastDismissalByType?.[type];
  if (lastOfType !== undefined) {
    const cooldown = perTypeCooldownMinutes(
      context.consecutiveDismissalsByType?.[type] ?? 0,
    );
    if (minutesSince(context.currentTime, lastOfType) < cooldown) {
      return 'per-type cooldown active';
    }
  }

  return null;
}
