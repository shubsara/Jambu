/**
 * Data export (docs/API.md §11; decision D105).
 *
 * This is the largest single disclosure Jambu makes, so it is built to be
 * *read* by the person it describes: a versioned envelope, explicit sections,
 * and an honest note when a collection was truncated.
 *
 * It cannot leak a URL or page content because neither was ever collected
 * (CLAUDE.md §9) — the most specific thing here is a registrable domain. The
 * column lists below are explicit rather than `select('*')` precisely so that
 * a future column cannot join the export by accident.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';

/**
 * Bumped on any breaking change to the shape below, so a file saved today
 * stays interpretable later.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Per-collection row cap (decision D105 — "bounded").
 *
 * Chosen to sit far above any realistic beta history while keeping a single
 * response something a browser can hold and a person can open. When a cap
 * bites, the export says so in `truncated` rather than quietly dropping rows:
 * an export that silently omits data is worse than one that admits a limit.
 */
export const EXPORT_MAX_ROWS = 10_000;

/**
 * PostgREST refuses to return more than `max_rows` in one response, and the
 * project sets that to 1000 (`supabase/config.toml`). A plain
 * `.limit(EXPORT_MAX_ROWS)` is therefore silently capped at 1000 — which would
 * truncate the export *and* leave `truncated` empty, the precise failure D105
 * exists to prevent. So collections are read a page at a time instead.
 */
const PAGE_SIZE = 1_000;

export interface ExportDocument {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly profile: unknown;
  readonly preferences: unknown;
  readonly onboarding: { readonly completedAt: string | null };
  readonly activitySessions: readonly unknown[];
  readonly routinePatterns: readonly unknown[];
  readonly interventions: readonly unknown[];
  readonly pause: unknown;
  readonly snoozes: readonly unknown[];
  /** Collections that hit {@link EXPORT_MAX_ROWS}, named rather than hidden. */
  readonly truncated: readonly string[];
}

async function readAll<T>(
  admin: SupabaseClient,
  table: string,
  columns: string,
  userId: string,
  orderBy: string,
): Promise<T[]> {
  const rows: T[] = [];

  while (rows.length < EXPORT_MAX_ROWS) {
    const from = rows.length;
    const to = Math.min(from + PAGE_SIZE, EXPORT_MAX_ROWS) - 1;

    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .order(orderBy, { ascending: true })
      .range(from, to);

    if (error !== null) {
      throw new ApiError('INTERNAL', 'Your data could not be exported.');
    }

    const page = (data ?? []) as T[];
    rows.push(...page);

    // A short page means the collection is exhausted.
    if (page.length < to - from + 1) {
      break;
    }
  }

  return rows;
}

export async function buildExport(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<ExportDocument> {
  const [user, preferences, sessions, routines, interventions, pause, snoozes] =
    await Promise.all([
      admin
        .from('users')
        .select('id, email, name, timezone, created_at, onboarding_completed_at')
        .eq('id', userId)
        .single(),
      admin
        .from('user_preferences')
        .select(
          'work_start, work_end, lunch_enabled, break_enabled, hydration_enabled, end_day_enabled, persona',
        )
        .eq('user_id', userId)
        .maybeSingle(),
      // Deliberately no `id` and no `client_session_id`: internal identifiers
      // tell the user nothing and only widen what leaves the system.
      readAll<Record<string, unknown>>(
        admin,
        'activity_sessions',
        'started_at, ended_at, active_seconds, domain',
        userId,
        'started_at',
      ),
      readAll<Record<string, unknown>>(
        admin,
        'routine_patterns',
        'pattern_type, day_of_week, start_time, end_time, interval_minutes, confidence, sample_count, updated_at',
        userId,
        'pattern_type',
      ),
      readAll<Record<string, unknown>>(
        admin,
        'interventions',
        'type, trigger, message, shown_at, response, responded_at, created_at',
        userId,
        'created_at',
      ),
      admin
        .from('pause_states')
        .select('paused_at, paused_until')
        .eq('user_id', userId)
        .maybeSingle(),
      readAll<Record<string, unknown>>(
        admin,
        'intervention_snoozes',
        'type, snoozed_until, created_at',
        userId,
        'type',
      ),
    ]);

  if (user.error !== null || user.data === null) {
    throw new ApiError('INTERNAL', 'Your data could not be exported.');
  }

  const profile = user.data as Record<string, unknown>;
  const truncated = (
    [
      ['activitySessions', sessions.length],
      ['routinePatterns', routines.length],
      ['interventions', interventions.length],
      ['snoozes', snoozes.length],
    ] as const
  )
    .filter(([, count]) => count >= EXPORT_MAX_ROWS)
    .map(([name]) => name);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    profile: {
      id: profile['id'],
      email: profile['email'],
      name: profile['name'],
      timezone: profile['timezone'],
      createdAt: profile['created_at'],
    },
    preferences: preferences.data ?? null,
    onboarding: {
      completedAt: (profile['onboarding_completed_at'] as string | null) ?? null,
    },
    activitySessions: sessions,
    routinePatterns: routines,
    interventions,
    pause: pause.data ?? null,
    snoozes,
    truncated,
  };
}
