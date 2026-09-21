/**
 * Registration (decision D18).
 *
 * Creating an account spans two systems that cannot share a transaction: the
 * Supabase Auth user is created over HTTP, the profile rows in Postgres. If
 * the second step fails, the first is compensated — otherwise an auth user
 * would exist with no profile, unable to register again and unable to use the
 * product.
 *
 * Profile creation is also idempotent, so a retry after a partial failure
 * adopts the existing rows instead of producing duplicates.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError, REGISTRATION_CONFLICT_MESSAGE } from '../errors.js';

export interface ProfileInput {
  readonly userId: string;
  readonly email: string;
  readonly name?: string | undefined;
  readonly timezone: string;
}

export interface CreatedProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly timezone: string;
}

/**
 * Create the `users` and `user_preferences` rows for a new auth user.
 *
 * Both writes are upserts keyed on the user id, so calling this twice for the
 * same user is harmless. Defaults for preferences come from the database
 * (hydration off per D7, persona `mom` per D10) rather than being restated
 * here, so there is one source of truth.
 */
export async function createProfile(
  admin: SupabaseClient,
  input: ProfileInput,
): Promise<CreatedProfile> {
  const { data, error } = await admin
    .from('users')
    .upsert(
      {
        id: input.userId,
        email: input.email,
        name: input.name ?? null,
        timezone: input.timezone,
      },
      { onConflict: 'id' },
    )
    .select('id, email, name, timezone')
    .single();

  if (error !== null || data === null) {
    throw new ApiError('INTERNAL', 'Registration could not be completed.');
  }

  const { error: preferencesError } = await admin.from('user_preferences').upsert(
    {
      user_id: input.userId,
      work_start: '09:00',
      work_end: '18:00',
    },
    { onConflict: 'user_id' },
  );

  if (preferencesError !== null) {
    throw new ApiError('INTERNAL', 'Registration could not be completed.');
  }

  return data as CreatedProfile;
}

/**
 * Undo a partially-completed registration.
 *
 * Removing the auth user cascades to any profile rows that did get written
 * (`users.id` references `auth.users(id) ON DELETE CASCADE`), so this single
 * call is enough to return the system to its pre-registration state.
 *
 * Failure here is logged by the caller and never surfaced: the user's
 * registration already failed, and a second error tells them nothing useful.
 */
export async function compensateFailedRegistration(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  return error === null;
}

/**
 * Map a Supabase sign-up failure to a response that reveals nothing.
 *
 * Whether the address is already registered is exactly what an attacker
 * probing for accounts wants to know, so a conflict and a policy rejection
 * are reported identically (decision D18).
 */
export function registrationFailure(): ApiError {
  return new ApiError('CONFLICT', REGISTRATION_CONFLICT_MESSAGE);
}
