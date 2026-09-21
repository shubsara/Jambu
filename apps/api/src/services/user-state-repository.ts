/**
 * Read-only data access for user state.
 *
 * P5 is strictly read-only: every function here issues a SELECT and nothing
 * else. No INSERT, UPDATE, DELETE, UPSERT or DDL, and no activity history is
 * modified. The facts belong to P4; this layer only reads them so the pure
 * derivation can interpret them.
 *
 * Every query is scoped by the authenticated user id supplied by the caller.
 * The service role bypasses RLS (docs/ARCHITECTURE.md §4.3), so that scoping
 * is the control that keeps one user's day out of another's response.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';
import type { LearnedLunchWindow, StoredSession } from './user-state.js';

/** Everything the derivation needs, read in one place. */
export interface UserStateFacts {
  readonly timeZone: string | null;
  readonly sessions: readonly StoredSession[];
  readonly learnedLunchWindow: LearnedLunchWindow | undefined;
  readonly lastLunchConfirmation: Date | undefined;
  readonly lastInterventionAt: Date | undefined;
  readonly paused: boolean;
}

/**
 * How far back sessions are read.
 *
 * Two days rather than one: the local day can begin up to 14 hours before or
 * after UTC midnight, and continuity runs need the sessions immediately
 * preceding the window to decide whether the current run is still open.
 */
const SESSION_LOOKBACK_HOURS = 48;

function failed(): ApiError {
  // The underlying message names tables and constraints (CLAUDE.md §31).
  return new ApiError('INTERNAL', 'User state could not be read.');
}

export async function readUserStateFacts(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<UserStateFacts> {
  const since = new Date(
    now.getTime() - SESSION_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();

  const [profile, sessions, routines, confirmations, interventions, pause] =
    await Promise.all([
      admin.from('users').select('timezone').eq('id', userId).maybeSingle(),

      admin
        .from('activity_sessions')
        // Deliberately not selecting `domain`: the response describes
        // durations, never what the user was looking at (CLAUDE.md §9).
        .select('started_at, ended_at, active_seconds')
        .eq('user_id', userId)
        .gte('started_at', since)
        .order('started_at', { ascending: true }),

      admin
        .from('routine_patterns')
        .select('start_time, end_time, confidence')
        .eq('user_id', userId)
        .eq('pattern_type', 'lunch')
        .is('day_of_week', null)
        .maybeSingle(),

      admin
        .from('interventions')
        .select('responded_at')
        .eq('user_id', userId)
        .eq('type', 'lunch')
        .eq('response', 'confirmed')
        .order('responded_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      admin
        .from('interventions')
        .select('shown_at')
        .eq('user_id', userId)
        .not('shown_at', 'is', null)
        .order('shown_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      admin.from('pause_states').select('user_id').eq('user_id', userId).maybeSingle(),
    ]);

  if (profile.error !== null || sessions.error !== null) {
    throw failed();
  }

  const rows = (sessions.data ?? []) as {
    started_at: string;
    ended_at: string;
    active_seconds: number;
  }[];

  const routine = routines.data as {
    start_time: string;
    end_time: string;
    confidence: number | string;
  } | null;

  return {
    timeZone: (profile.data as { timezone: string } | null)?.timezone ?? null,
    sessions: rows.map((row) => ({
      startedAt: new Date(row.started_at),
      endedAt: new Date(row.ended_at),
      activeSeconds: row.active_seconds,
    })),
    learnedLunchWindow:
      routine === null
        ? undefined
        : {
            // TIME columns arrive as `HH:mm:ss`; the derivation wants `HH:mm`.
            start: routine.start_time.slice(0, 5),
            end: routine.end_time.slice(0, 5),
            confidence: Number(routine.confidence),
          },
    lastLunchConfirmation: toDate(
      (confirmations.data as { responded_at: string | null } | null)?.responded_at,
    ),
    lastInterventionAt: toDate(
      (interventions.data as { shown_at: string | null } | null)?.shown_at,
    ),
    paused: pause.data !== null,
  };
}

function toDate(value: string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : new Date(value);
}
