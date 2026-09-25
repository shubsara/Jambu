/**
 * Routine learning at the storage boundary (CLAUDE.md §16, decisions D79-D84).
 *
 * The learning itself is pure and lives in `@jambu/routine-learning`. This
 * module does the three things that package must not: it reads activity, it
 * converts instants to local wall-clock time, and it writes the results.
 *
 * Privacy: the query below selects **no domain**. The pure package receives a
 * local day and two minute offsets per run and nothing else, so it cannot
 * learn anything about *what* the user was doing (CLAUDE.md §9).
 *
 * Continuity is not redefined here either: runs come from P5's `foldIntoRuns`,
 * so decision D6's ten-minute rule still exists in exactly one place.
 */
import {
  learnRoutines,
  toTimeOfDay,
  type LearnedRoutines,
  type LocalRun,
} from '@jambu/routine-learning';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';
import { resolveTimeZone, wallClockAt } from '../lib/timezone.js';
import { foldIntoRuns, type StoredSession } from './user-state.js';

/** Decision D79 — how far back learning looks. */
export const OBSERVATION_WINDOW_DAYS = 28;

/**
 * Decision D83 — how stale routines may get before a lazy recalculation.
 *
 * There is no scheduler in this project, so recalculation piggybacks on
 * activity ingest. A day is long enough that the cost is negligible and short
 * enough that a changed routine is picked up promptly.
 */
export const RECALCULATION_INTERVAL_HOURS = 24;

const MINUTES_PER_DAY = 24 * 60;

/** Convert a run to the user's local day and minute offsets. */
function toLocalRun(run: { startedAt: Date; endedAt: Date }, timeZone: string): LocalRun {
  const start = wallClockAt(run.startedAt, timeZone);
  const end = wallClockAt(run.endedAt, timeZone);

  const startMinute = start.hour * 60 + start.minute;
  const rawEndMinute = end.hour * 60 + end.minute;

  // A run crossing local midnight is attributed wholly to the day it started
  // in, matching the P5 rule documented in ARCHITECTURE.md §6.1.
  const crossesMidnight =
    end.year !== start.year || end.month !== start.month || end.day !== start.day;

  return {
    localDay: `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`,
    startMinute,
    endMinute: crossesMidnight ? MINUTES_PER_DAY - 1 : rawEndMinute,
  };
}

/** Read a user's recent activity as local runs, carrying no domain. */
export async function readLocalRuns(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<LocalRun[]> {
  const since = new Date(
    now.getTime() - OBSERVATION_WINDOW_DAYS * 24 * 3_600_000,
  ).toISOString();

  const [profile, sessions] = await Promise.all([
    admin.from('users').select('timezone').eq('id', userId).maybeSingle(),
    admin
      .from('activity_sessions')
      // Deliberately no `domain`: learning is about when, never what.
      .select('started_at, ended_at, active_seconds')
      .eq('user_id', userId)
      .gte('started_at', since)
      .order('started_at', { ascending: true }),
  ]);

  if (sessions.error !== null) {
    throw new ApiError('INTERNAL', 'Activity could not be read.');
  }

  const timeZone = resolveTimeZone(
    (profile.data as { timezone: string } | null)?.timezone,
  );

  const stored: StoredSession[] = (
    (sessions.data ?? []) as {
      started_at: string;
      ended_at: string;
      active_seconds: number;
    }[]
  ).map((row) => ({
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    activeSeconds: row.active_seconds,
  }));

  // Reuses P5's continuity rule rather than restating it.
  return foldIntoRuns(stored).map((run) => toLocalRun(run, timeZone));
}

interface RoutineRow {
  readonly user_id: string;
  readonly pattern_type: string;
  readonly day_of_week: null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly interval_minutes: number | null;
  readonly confidence: number;
  readonly sample_count: number;
  readonly updated_at: string;
}

/**
 * Turn learned routines into rows.
 *
 * Decision D80: every row is an all-days row (`day_of_week = null`). Learning
 * per weekday needs roughly five times the evidence to reach the same
 * confidence, and the schema can already hold per-day rows when that is worth
 * doing.
 */
function toRows(userId: string, learned: LearnedRoutines, now: Date): RoutineRow[] {
  const rows: RoutineRow[] = [];
  const updatedAt = now.toISOString();

  const window = (
    type: string,
    value: {
      startMinute: number;
      endMinute: number;
      confidence: number;
      sampleCount: number;
    },
  ): RoutineRow => ({
    user_id: userId,
    pattern_type: type,
    day_of_week: null,
    start_time: toTimeOfDay(value.startMinute),
    end_time: toTimeOfDay(value.endMinute),
    interval_minutes: null,
    confidence: value.confidence,
    sample_count: value.sampleCount,
    updated_at: updatedAt,
  });

  if (learned.lunch !== null) rows.push(window('lunch', learned.lunch));
  if (learned.workStart !== null) rows.push(window('work_start', learned.workStart));
  if (learned.workEnd !== null) rows.push(window('work_end', learned.workEnd));

  if (learned.breakInterval !== null) {
    rows.push({
      user_id: userId,
      pattern_type: 'break_interval',
      day_of_week: null,
      // Decision D77: a duration is stored as a duration.
      start_time: null,
      end_time: null,
      interval_minutes: learned.breakInterval.intervalMinutes,
      confidence: learned.breakInterval.confidence,
      sample_count: learned.breakInterval.sampleCount,
      updated_at: updatedAt,
    });
  }

  return rows;
}

export interface RecalculationResult {
  readonly written: number;
  readonly learned: LearnedRoutines;
}

/**
 * Recalculate and persist a user's routines.
 *
 * Idempotent: the same activity produces the same rows, upserted on
 * `(user_id, pattern_type, day_of_week)`. Patterns that fall below the §16
 * observation threshold are simply not written — the caller keeps the D8
 * default rather than storing a guess.
 */
export async function recalculateRoutines(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<RecalculationResult> {
  const runs = await readLocalRuns(admin, userId, now);
  const learned = learnRoutines(runs);
  const rows = toRows(userId, learned, now);

  if (rows.length === 0) {
    return { written: 0, learned };
  }

  const { error } = await admin
    .from('routine_patterns')
    .upsert(rows, { onConflict: 'user_id,pattern_type,day_of_week' });

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Routines could not be stored.');
  }

  return { written: rows.length, learned };
}

/**
 * Recalculate only if the stored routines have gone stale (decision D83).
 *
 * Staleness is read from the newest `updated_at` rather than a dedicated
 * column, so this needed no second migration. A user with no routines at all
 * is stale by definition, which is what makes the first recalculation happen.
 */
export async function recalculateIfStale(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from('routine_patterns')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    return false;
  }

  const lastUpdated = (data as { updated_at: string } | null)?.updated_at;
  if (lastUpdated !== undefined) {
    const hoursSince = (now.getTime() - Date.parse(lastUpdated)) / 3_600_000;
    if (hoursSince < RECALCULATION_INTERVAL_HOURS) {
      return false;
    }
  }

  await recalculateRoutines(admin, userId, now);
  return true;
}
