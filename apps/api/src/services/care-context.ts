/**
 * CareContext assembly (decision D48).
 *
 * The Care Engine is pure and knows nothing about storage, so someone has to
 * gather the facts it reasons over. That is this module's only job.
 *
 * It deliberately does **not** widen `GET /api/user/state` or its repository:
 * P5 is read-only and its guarantee is worth keeping intact. It reuses P5's
 * derivation rather than reimplementing continuity, so the ten-minute rule
 * exists in exactly one place.
 *
 * Every query is scoped to the authenticated user id supplied by the caller.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CareContext, InterventionType, UserPreferences } from '@jambu/shared-types';

import { ApiError } from '../errors.js';
import { localTimeOnDay, resolveTimeZone } from '../lib/timezone.js';
import { readUserStateFacts } from './user-state-repository.js';
import { deriveUserState } from './user-state.js';

/** How many recent interventions to inspect for dismissal history. */
const HISTORY_LIMIT = 50;

interface InterventionHistoryRow {
  readonly type: string;
  readonly response: string | null;
  readonly responded_at: string | null;
  readonly message: string;
}

/** What the caller needs alongside the context to render and record. */
export interface AssembledContext {
  readonly context: CareContext;
  /** Most recent stored message per type, for the D43 selector. */
  readonly previousMessageByType: Readonly<Partial<Record<InterventionType, string>>>;
}

function toDate(value: string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : new Date(value);
}

/**
 * Consecutive dismissals per type, counted from the most recent response
 * backwards. Any other response breaks the streak, so a single confirmation
 * resets the D36 backoff.
 */
function consecutiveDismissals(
  rows: readonly InterventionHistoryRow[],
): Partial<Record<InterventionType, number>> {
  const counts: Partial<Record<InterventionType, number>> = {};
  const settled: Partial<Record<InterventionType, boolean>> = {};

  for (const row of rows) {
    if (row.response === null) {
      continue;
    }
    const type = row.type as InterventionType;
    if (settled[type] === true) {
      continue;
    }
    if (row.response === 'dismissed') {
      counts[type] = (counts[type] ?? 0) + 1;
    } else {
      settled[type] = true;
    }
  }

  return counts;
}

function lastDismissals(
  rows: readonly InterventionHistoryRow[],
): Partial<Record<InterventionType, Date>> {
  const last: Partial<Record<InterventionType, Date>> = {};
  for (const row of rows) {
    const type = row.type as InterventionType;
    if (
      row.response === 'dismissed' &&
      row.responded_at !== null &&
      last[type] === undefined
    ) {
      last[type] = new Date(row.responded_at);
    }
  }
  return last;
}

function previousMessages(
  rows: readonly InterventionHistoryRow[],
): Partial<Record<InterventionType, string>> {
  const previous: Partial<Record<InterventionType, string>> = {};
  for (const row of rows) {
    const type = row.type as InterventionType;
    if (previous[type] === undefined) {
      previous[type] = row.message;
    }
  }
  return previous;
}

/**
 * Build the context the Care Engine reasons over.
 *
 * `now` is supplied by the caller and passed through, so the engine's purity
 * contract survives the trip through storage.
 */
export async function assembleCareContext(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<AssembledContext> {
  const facts = await readUserStateFacts(admin, userId, now);
  const timeZone = resolveTimeZone(facts.timeZone);

  const [preferences, snoozes, history, hydration, routines, pause] = await Promise.all([
    admin
      .from('user_preferences')
      .select(
        'work_start, work_end, lunch_enabled, break_enabled, hydration_enabled, end_day_enabled, persona',
      )
      .eq('user_id', userId)
      .maybeSingle(),

    admin
      .from('intervention_snoozes')
      .select('type, snoozed_until')
      .eq('user_id', userId),

    admin
      .from('interventions')
      .select('type, response, responded_at, message')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),

    admin
      .from('interventions')
      .select('responded_at')
      .eq('user_id', userId)
      .eq('type', 'hydration')
      .eq('response', 'confirmed')
      .order('responded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    admin
      .from('routine_patterns')
      .select('pattern_type, start_time, end_time, interval_minutes, confidence')
      .eq('user_id', userId)
      .is('day_of_week', null),

    admin.from('pause_states').select('paused_until').eq('user_id', userId).maybeSingle(),
  ]);

  if (preferences.error !== null || preferences.data === null) {
    throw new ApiError('INTERNAL', 'User preferences could not be read.');
  }

  const state = deriveUserState({
    now,
    timeZone,
    sessions: facts.sessions,
    learnedLunchWindow: facts.learnedLunchWindow,
    lastLunchConfirmation: facts.lastLunchConfirmation,
    lastInterventionAt: facts.lastInterventionAt,
    paused: facts.paused,
  });

  const prefRow = preferences.data as {
    work_start: string;
    work_end: string;
    lunch_enabled: boolean;
    break_enabled: boolean;
    hydration_enabled: boolean;
    end_day_enabled: boolean;
    persona: string;
  };

  const userPreferences: UserPreferences = {
    workStart: prefRow.work_start.slice(0, 5),
    workEnd: prefRow.work_end.slice(0, 5),
    lunchEnabled: prefRow.lunch_enabled,
    breakEnabled: prefRow.break_enabled,
    hydrationEnabled: prefRow.hydration_enabled,
    endDayEnabled: prefRow.end_day_enabled,
    persona: prefRow.persona,
  };

  const historyRows = (history.data ?? []) as InterventionHistoryRow[];

  const snoozedUntilByType: Partial<Record<InterventionType, Date>> = {};
  for (const row of (snoozes.data ?? []) as { type: string; snoozed_until: string }[]) {
    snoozedUntilByType[row.type as InterventionType] = new Date(row.snoozed_until);
  }

  const routineRows = (routines.data ?? []) as {
    pattern_type: string;
    start_time: string | null;
    end_time: string | null;
    interval_minutes: number | null;
    confidence: number | string;
  }[];
  const routineOf = (type: string) => routineRows.find((r) => r.pattern_type === type);

  // Learned work hours, resolved to instants here because decision D39 keeps
  // timezone arithmetic out of the engine.
  const workStartRow = routineOf('work_start');
  const workEndRow = routineOf('work_end');
  const workHours =
    workStartRow?.start_time !== null &&
    workStartRow?.start_time !== undefined &&
    workEndRow?.end_time !== null &&
    workEndRow?.end_time !== undefined
      ? {
          start: localTimeOnDay(now, timeZone, workStartRow.start_time.slice(0, 5)),
          end: localTimeOnDay(now, timeZone, workEndRow.end_time.slice(0, 5)),
          confidence: Math.min(
            Number(workStartRow.confidence),
            Number(workEndRow.confidence),
          ),
        }
      : undefined;

  // Decision D77: a break interval is a duration, stored in interval_minutes.
  // P7 read it as a time span, which could not express an interval beyond a
  // day and misrepresented what start_time and end_time mean.
  const breakRow = routineOf('break_interval');
  const breakPattern =
    breakRow?.interval_minutes !== null && breakRow?.interval_minutes !== undefined
      ? {
          averageIntervalMinutes: breakRow.interval_minutes,
          confidence: Number(breakRow.confidence),
        }
      : undefined;

  const lunchWindow =
    state.lunchWindow === undefined
      ? undefined
      : {
          start: new Date(state.lunchWindow.start),
          end: new Date(state.lunchWindow.end),
          confidence: state.lunchWindow.confidence,
        };

  const pausedUntil = toDate(
    (pause.data as { paused_until: string | null } | null)?.paused_until,
  );

  const context: CareContext = {
    currentTime: now,
    continuousWorkMinutes: state.continuousWorkMinutes,
    totalWorkMinutesToday: state.totalWorkMinutesToday,
    currentActivity: state.currentActivity,
    ...(lunchWindow === undefined ? {} : { lunchWindow }),
    ...(breakPattern === undefined ? {} : { breakPattern }),
    ...(workHours === undefined ? {} : { workHours }),
    ...(facts.lastLunchConfirmation === undefined
      ? {}
      : { lastLunchConfirmation: facts.lastLunchConfirmation }),
    ...(toDate(
      (hydration.data as { responded_at: string | null } | null)?.responded_at,
    ) === undefined
      ? {}
      : {
          lastHydrationConfirmation: toDate(
            (hydration.data as { responded_at: string | null } | null)?.responded_at,
          ) as Date,
        }),
    ...(facts.lastInterventionAt === undefined
      ? {}
      : { lastIntervention: facts.lastInterventionAt }),
    lastDismissalByType: lastDismissals(historyRows),
    consecutiveDismissalsByType: consecutiveDismissals(historyRows),
    snoozedUntilByType,
    isPaused: facts.paused,
    ...(pausedUntil === undefined ? {} : { pausedUntil }),
    preferences: userPreferences,
  };

  return { context, previousMessageByType: previousMessages(historyRows) };
}
