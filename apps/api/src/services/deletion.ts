/**
 * Data and account deletion (docs/API.md §11; decisions D104, D106, D107).
 *
 * `deletion_requests` has existed since P2 with nothing referencing it. This
 * is what finally uses it, and what makes its `pending` status reachable.
 *
 * **Asynchronous by decision D104.** The route records the request and returns
 * `202`; the work runs afterwards and moves the row to `completed` or
 * `failed`. No scheduler is introduced — the deletion is kicked off in the
 * same process, the same best-effort shape P7, P9 and P11's D83 already use.
 * The client learns the outcome by polling, never by assuming.
 *
 * The audit row is deliberately thin: an opaque user id, a scope, a status and
 * two timestamps. It must survive the account it describes — which is why
 * `deletion_requests.user_id` carries no foreign key — so it must carry
 * nothing that could identify the person afterwards.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';

export type DeletionScope = 'activity' | 'account';
export type DeletionStatus = 'pending' | 'completed' | 'failed';

export interface DeletionRequestView {
  readonly id: string;
  readonly scope: DeletionScope;
  readonly status: DeletionStatus;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

/** Tables cleared for `scope: 'activity'` — the account itself survives. */
const ACTIVITY_TABLES = [
  'interventions',
  'routine_patterns',
  'activity_sessions',
] as const;

/** Everything else an account owns, cleared for `scope: 'account'`. */
const ACCOUNT_TABLES = [
  'intervention_snoozes',
  'pause_states',
  'user_preferences',
] as const;

function toView(row: Record<string, unknown>): DeletionRequestView {
  return {
    id: row['id'] as string,
    scope: row['scope'] as DeletionScope,
    status: row['status'] as DeletionStatus,
    requestedAt: new Date(row['requested_at'] as string).toISOString(),
    completedAt:
      row['completed_at'] === null || row['completed_at'] === undefined
        ? null
        : new Date(row['completed_at'] as string).toISOString(),
  };
}

async function recordRequest(
  admin: SupabaseClient,
  userId: string,
  scope: DeletionScope,
  now: Date,
): Promise<DeletionRequestView> {
  const { data, error } = await admin
    .from('deletion_requests')
    .insert({
      user_id: userId,
      scope,
      status: 'pending',
      requested_at: now.toISOString(),
    })
    .select('id, scope, status, requested_at, completed_at')
    .single();

  if (error !== null || data === null) {
    throw new ApiError('INTERNAL', 'The deletion request could not be recorded.');
  }
  return toView(data as Record<string, unknown>);
}

async function settle(
  admin: SupabaseClient,
  requestId: string,
  status: Exclude<DeletionStatus, 'pending'>,
  now: Date,
): Promise<void> {
  await admin
    .from('deletion_requests')
    .update({
      status,
      completed_at: status === 'completed' ? now.toISOString() : null,
    })
    .eq('id', requestId);
}

async function clearTables(
  admin: SupabaseClient,
  userId: string,
  tables: readonly string[],
): Promise<void> {
  // Sequential, not parallel: `interventions` before `routine_patterns` before
  // `activity_sessions`, so a partial failure never leaves a row referencing
  // one that is already gone.
  for (const table of tables) {
    const { error } = await admin.from(table).delete().eq('user_id', userId);
    if (error !== null) {
      throw new ApiError('INTERNAL', `Deletion failed while clearing ${table}.`);
    }
  }
}

/**
 * Delete activity and everything derived from it, keeping the account.
 *
 * Preferences, pause and snooze state survive — they are the user's settings,
 * not their history.
 */
export async function performActivityDeletion(
  admin: SupabaseClient,
  userId: string,
  requestId: string,
  now: Date,
): Promise<void> {
  try {
    await clearTables(admin, userId, ACTIVITY_TABLES);
    await settle(admin, requestId, 'completed', now);
  } catch {
    await settle(admin, requestId, 'failed', now);
  }
}

/**
 * Delete the account and everything it owns.
 *
 * The auth user goes last. Removing it cascades `public.users` away, so doing
 * it first would leave the deletion unable to find the rows it still has to
 * clear — and `deletion_requests` deliberately has no foreign key, so the
 * audit row outlives all of it.
 */
export async function performAccountDeletion(
  admin: SupabaseClient,
  userId: string,
  requestId: string,
  now: Date,
): Promise<void> {
  try {
    await clearTables(admin, userId, [...ACTIVITY_TABLES, ...ACCOUNT_TABLES]);

    const { error: softDeleteError } = await admin
      .from('users')
      .update({ deleted_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', userId);
    if (softDeleteError !== null) {
      throw new ApiError('INTERNAL', 'The account could not be marked deleted.');
    }

    const { error: authError } = await admin.auth.admin.deleteUser(userId);
    if (authError !== null) {
      throw new ApiError('INTERNAL', 'The account could not be removed.');
    }

    await settle(admin, requestId, 'completed', now);
  } catch {
    await settle(admin, requestId, 'failed', now);
  }
}

/**
 * Start a deletion and hand back the request to poll (decision D104).
 *
 * The work is started but not awaited: the caller gets `202` immediately, and
 * the request row is the only place the outcome is reported.
 */
export async function requestDeletion(
  admin: SupabaseClient,
  userId: string,
  scope: DeletionScope,
  now: Date,
  onFailure: (cause: unknown) => void,
): Promise<DeletionRequestView> {
  const request = await recordRequest(admin, userId, scope, now);

  const work =
    scope === 'activity'
      ? performActivityDeletion(admin, userId, request.id, now)
      : performAccountDeletion(admin, userId, request.id, now);

  void work.catch(onFailure);

  return request;
}

/**
 * Read one request, scoped to its owner — **activity scope in practice**.
 *
 * Completing an account deletion destroys the auth user, and with it the token
 * this authenticated endpoint requires, so a client polling its own account
 * deletion gets `401`. D104 and D107 were resolved in favour of the simpler
 * reading: for account scope the `202` **is** the confirmation, and the client
 * never polls (see ARCHITECTURE §14.5).
 *
 * The audit row still outlives the account — it has no foreign key for exactly
 * that reason — but it is there for operators, not for the departing user.
 *
 * The `401` is asserted in `control.integration.test.ts`. Not because it is a
 * defect, but because the alternative fix would be to drop authentication from
 * a route that reports deletion status, and that should never happen quietly.
 */
export async function readDeletionRequest(
  admin: SupabaseClient,
  userId: string,
  requestId: string,
): Promise<DeletionRequestView | null> {
  const { data, error } = await admin
    .from('deletion_requests')
    .select('id, scope, status, requested_at, completed_at')
    .eq('id', requestId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('INTERNAL', 'The deletion request could not be read.');
  }
  return data === null ? null : toView(data as Record<string, unknown>);
}
