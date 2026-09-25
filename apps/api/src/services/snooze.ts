/**
 * Snooze (docs/API.md §10; decisions D102, D103).
 *
 * A snooze is something the user earns by answering a card with "remind me
 * later". It is a reaction to a moment, not a schedule — which is why this
 * module can read and clear one but offers **no way to create one** (D102).
 * `recordResponse` in `intervention.ts` remains the only writer.
 *
 * CLAUDE.md §3.2 is the reason. A settings screen that let someone say
 * "silence lunch until 3pm" would be asking them to schedule their own care,
 * which is the chore Jambu exists to remove.
 */
import type { InterventionType } from '@jambu/shared-types';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';

export interface SnoozeView {
  readonly type: InterventionType;
  readonly snoozedUntil: string;
}

interface SnoozeRow {
  readonly type: string;
  readonly snoozed_until: string;
}

/**
 * Active snoozes only.
 *
 * A row whose `snoozed_until` has passed is spent, not current, and showing it
 * would suggest Jambu is still silenced when it is not.
 */
export async function listActiveSnoozes(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<SnoozeView[]> {
  const { data, error } = await admin
    .from('intervention_snoozes')
    .select('type, snoozed_until')
    .eq('user_id', userId)
    .gt('snoozed_until', now.toISOString())
    .order('type', { ascending: true });

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Snoozes could not be read.');
  }

  return ((data ?? []) as SnoozeRow[]).map((row) => ({
    type: row.type as InterventionType,
    snoozedUntil: new Date(row.snoozed_until).toISOString(),
  }));
}

/**
 * Clear one type's snooze. Idempotent — clearing nothing is a success.
 *
 * Also the mechanism behind D103: disabling an intervention type clears its
 * snooze, because turning a type off is the stronger, more deliberate
 * statement and should not leave a weaker temporary one behind it.
 */
export async function clearSnooze(
  admin: SupabaseClient,
  userId: string,
  type: InterventionType,
): Promise<void> {
  const { error } = await admin
    .from('intervention_snoozes')
    .delete()
    .eq('user_id', userId)
    .eq('type', type);

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Snooze could not be cleared.');
  }
}
