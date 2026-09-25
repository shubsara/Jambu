/**
 * Pause (docs/API.md §9; decisions D99, D100).
 *
 * Until now `pause_states` had two readers and no writer — the §14 `-100` term
 * was scored but unreachable, and no user could actually pause Jambu. This is
 * the writer.
 *
 * Two things pause is **not**:
 *
 *   - It does not stop observation (D99). Pausing means "don't talk to me",
 *     not "don't look at me". Consent to observe is onboarding (D93) and
 *     removal of what was observed is deletion (§11). Three promises, three
 *     controls, none of them quietly standing in for another.
 *   - It does not answer an intervention on the user's behalf. Expiring a live
 *     card records `expired`, never a response the user did not give.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';
import { expireStale } from './intervention.js';

export interface PauseState {
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly pausedUntil: string | null;
}

const NOT_PAUSED: PauseState = { paused: false, pausedAt: null, pausedUntil: null };

interface PauseRow {
  readonly paused_at: string;
  readonly paused_until: string | null;
}

/**
 * A stored row whose `paused_until` has passed is not a pause any more.
 *
 * Read as expired rather than deleted: the row is harmless, and a read path
 * that quietly writes is a surprise waiting to happen.
 */
function toState(row: PauseRow | null, now: Date): PauseState {
  if (row === null) {
    return NOT_PAUSED;
  }
  if (row.paused_until !== null && new Date(row.paused_until) <= now) {
    return NOT_PAUSED;
  }
  return {
    paused: true,
    pausedAt: new Date(row.paused_at).toISOString(),
    pausedUntil:
      row.paused_until === null ? null : new Date(row.paused_until).toISOString(),
  };
}

export async function readPause(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<PauseState> {
  const { data, error } = await admin
    .from('pause_states')
    .select('paused_at, paused_until')
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Pause state could not be read.');
  }
  return toState(data as PauseRow | null, now);
}

/**
 * Take back anything currently on screen (decision D100).
 *
 * Marks the row `expired`, the same ending a timeout gives it, rather than
 * inventing a second way for an intervention to finish. No response value is
 * fabricated. The card's own removal is the extension's job; this is the
 * server side of it.
 */
async function expireLiveIntervention(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<void> {
  const { error } = await admin
    .from('interventions')
    .update({ response: 'expired', responded_at: now.toISOString() })
    .eq('user_id', userId)
    .is('response', null);

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Live interventions could not be cleared.');
  }
}

/**
 * Pause, and silence Jambu immediately.
 *
 * Decision D100: a Care Card already on screen is expired here and now. D69
 * says an unanswered card persists, and that still holds everywhere else — but
 * the user has just said "not now", and leaving the card up would contradict
 * the very instruction that removed it. §42 requires pausing to silence Jambu
 * *immediately*, and a card still on the page is Jambu still talking.
 */
export async function startPause(
  admin: SupabaseClient,
  userId: string,
  until: Date | null,
  now: Date,
): Promise<PauseState> {
  if (until !== null && until <= now) {
    throw new ApiError('VALIDATION_FAILED', 'A pause must end in the future.');
  }

  const { error } = await admin.from('pause_states').upsert(
    {
      user_id: userId,
      paused_at: now.toISOString(),
      paused_until: until === null ? null : until.toISOString(),
      source: 'user',
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Pause could not be started.');
  }

  await expireLiveIntervention(admin, userId, now);
  return await readPause(admin, userId, now);
}

/** Resume. Idempotent when not paused (docs/API.md §9). */
export async function endPause(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<PauseState> {
  const { error } = await admin.from('pause_states').delete().eq('user_id', userId);

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Pause could not be ended.');
  }

  // Anything that expired while paused stays expired; resuming does not
  // resurrect a card the user never saw.
  await expireStale(admin, userId, now);
  return NOT_PAUSED;
}
