/**
 * Reading and updating user preferences (docs/API.md §6).
 *
 * Preferences span two tables. The four toggles, work hours and persona live
 * on `user_preferences`; `timezone` and `onboarding_completed_at` live on
 * `users`. That split is a storage detail, so this module hides it and the
 * client sees one object (decisions D90, A1).
 */
import type {
  InterventionType,
  PreferenceFieldName,
  PreferencesView,
} from '@jambu/shared-types';
import type { SupabaseClient } from '@supabase/supabase-js';

import { emit } from '../lib/analytics.js';
import { ApiError } from '../errors.js';
import type { UpdatePreferencesRequest } from '../schemas/preferences.js';
import { clearSnooze } from './snooze.js';

interface PreferencesRow {
  readonly work_start: string;
  readonly work_end: string;
  readonly lunch_enabled: boolean;
  readonly break_enabled: boolean;
  readonly hydration_enabled: boolean;
  readonly end_day_enabled: boolean;
  readonly persona: string;
}

interface UserRow {
  readonly timezone: string;
  readonly onboarding_completed_at: string | null;
}

const PREFERENCE_COLUMNS =
  'work_start, work_end, lunch_enabled, break_enabled, hydration_enabled, end_day_enabled, persona';

/** `TIME` comes back as `09:00:00`; the contract is `HH:mm`. */
function toTimeOfDay(value: string): string {
  return value.slice(0, 5);
}

function toView(preferences: PreferencesRow, user: UserRow): PreferencesView {
  return {
    workStart: toTimeOfDay(preferences.work_start),
    workEnd: toTimeOfDay(preferences.work_end),
    lunchEnabled: preferences.lunch_enabled,
    breakEnabled: preferences.break_enabled,
    hydrationEnabled: preferences.hydration_enabled,
    endDayEnabled: preferences.end_day_enabled,
    persona: preferences.persona,
    timezone: user.timezone,
    // Resolution A1 — the extension's only way to learn whether onboarding is
    // done, which D93 turns into whether it may track anything at all.
    onboardingCompletedAt:
      user.onboarding_completed_at === null
        ? null
        : new Date(user.onboarding_completed_at).toISOString(),
  };
}

export async function readPreferences(
  admin: SupabaseClient,
  userId: string,
): Promise<PreferencesView> {
  const [preferences, user] = await Promise.all([
    admin
      .from('user_preferences')
      .select(PREFERENCE_COLUMNS)
      .eq('user_id', userId)
      .single(),
    admin
      .from('users')
      .select('timezone, onboarding_completed_at')
      .eq('id', userId)
      .single(),
  ]);

  if (preferences.error !== null || preferences.data === null) {
    throw new ApiError('INTERNAL', 'Preferences could not be read.');
  }
  if (user.error !== null || user.data === null) {
    throw new ApiError('INTERNAL', 'Preferences could not be read.');
  }

  return toView(preferences.data as unknown as PreferencesRow, user.data as UserRow);
}

/**
 * Apply a partial update and return the full object.
 *
 * The two tables are written separately because PostgREST cannot span them in
 * one call. A failure on either is reported as a single failure; there is no
 * partial-success response, because a client that got one could not tell what
 * had actually been stored.
 */
/**
 * Database column -> D113 `changedFields` name.
 *
 * Explicit rather than a camel-case transform: the map is the allowlist. A
 * column added later is simply absent here and is reported as nothing, which
 * is the safe direction - a new column cannot leak into analytics by default.
 */
const COLUMN_TO_PREFERENCE_FIELD: Readonly<Record<string, PreferenceFieldName>> = {
  work_start: 'workStart',
  work_end: 'workEnd',
  lunch_enabled: 'lunchEnabled',
  break_enabled: 'breakEnabled',
  hydration_enabled: 'hydrationEnabled',
  end_day_enabled: 'endDayEnabled',
  persona: 'persona',
  timezone: 'timezone',
};

export async function updatePreferences(
  admin: SupabaseClient,
  userId: string,
  update: UpdatePreferencesRequest,
  now: Date,
): Promise<PreferencesView> {
  const preferencePatch: Record<string, unknown> = {};
  if (update.workStart !== undefined) preferencePatch['work_start'] = update.workStart;
  if (update.workEnd !== undefined) preferencePatch['work_end'] = update.workEnd;
  if (update.lunchEnabled !== undefined)
    preferencePatch['lunch_enabled'] = update.lunchEnabled;
  if (update.breakEnabled !== undefined)
    preferencePatch['break_enabled'] = update.breakEnabled;
  if (update.hydrationEnabled !== undefined)
    preferencePatch['hydration_enabled'] = update.hydrationEnabled;
  if (update.endDayEnabled !== undefined)
    preferencePatch['end_day_enabled'] = update.endDayEnabled;
  if (update.persona !== undefined) preferencePatch['persona'] = update.persona;

  if (Object.keys(preferencePatch).length > 0) {
    preferencePatch['updated_at'] = now.toISOString();
    const { error } = await admin
      .from('user_preferences')
      .update(preferencePatch)
      .eq('user_id', userId);
    if (error !== null) {
      throw new ApiError('INTERNAL', 'Preferences could not be updated.');
    }
  }

  const userPatch: Record<string, unknown> = {};
  if (update.timezone !== undefined) userPatch['timezone'] = update.timezone;

  if (Object.keys(userPatch).length > 0) {
    userPatch['updated_at'] = now.toISOString();
    const { error } = await admin.from('users').update(userPatch).eq('id', userId);
    if (error !== null) {
      throw new ApiError('INTERNAL', 'Preferences could not be updated.');
    }
  }

  if (update.onboardingCompleted === true) {
    const transitioned = await markOnboardingComplete(admin, userId, now);
    if (transitioned) {
      // Only on the real incomplete -> complete transition (resolution A2).
      emit({
        event: 'onboarding_completed',
        occurredAt: now.toISOString(),
        userId,
      });
    }
  }

  // Key names only, never values: a `workStart` value would disclose the
  // user's daily schedule, and decision D113 keeps values out of analytics
  // entirely. Derived from the patches actually applied above, so a no-op
  // field in the request does not report itself as a change.
  const changedFields = [
    ...Object.keys(preferencePatch).filter((key) => key !== 'updated_at'),
    ...Object.keys(userPatch).filter((key) => key !== 'updated_at'),
  ]
    .map((column) => COLUMN_TO_PREFERENCE_FIELD[column])
    .filter((field): field is PreferenceFieldName => field !== undefined);

  if (changedFields.length > 0) {
    emit({
      event: 'settings_changed',
      occurredAt: now.toISOString(),
      userId,
      changedFields,
    });
  }

  await clearSnoozesForDisabledTypes(admin, userId, update);

  return await readPreferences(admin, userId);
}

/**
 * Stamp completion, once (resolution A2).
 *
 * `is('onboarding_completed_at', null)` is what makes this idempotent: the
 * first completion wins and a repeat call is a no-op rather than a fresh
 * timestamp. Completion is only ever reached through an explicit
 * `onboardingCompleted: true` — never inferred from an ordinary preference
 * update, because in P13 a settings edit by a user who never onboarded would
 * otherwise switch tracking on behind their back (D93).
 */
async function markOnboardingComplete(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from('users')
    .update({ onboarding_completed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', userId)
    .is('onboarding_completed_at', null)
    // `.select()` is what turns the existing idempotence into an observable
    // fact. Without it the update cannot say whether it stamped a row or
    // matched none, and a repeated completion request would emit a duplicate
    // `onboarding_completed`. Rows returned === the transition happened here.
    .select('id');

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Onboarding could not be completed.');
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Decision D103 — turning a type off clears its snooze.
 *
 * Disabling is the stronger, more deliberate statement; leaving a temporary
 * silence behind it would be state nobody asked for and nobody can see.
 * Re-enabling restores eligibility only — it never recreates an intervention.
 */
async function clearSnoozesForDisabledTypes(
  admin: SupabaseClient,
  userId: string,
  update: UpdatePreferencesRequest,
): Promise<void> {
  const disabled: InterventionType[] = [];
  if (update.lunchEnabled === false) disabled.push('lunch');
  if (update.breakEnabled === false) disabled.push('break');
  if (update.hydrationEnabled === false) disabled.push('hydration');
  if (update.endDayEnabled === false) disabled.push('end_of_day');

  for (const type of disabled) {
    await clearSnooze(admin, userId, type);
  }
}
