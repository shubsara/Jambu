/**
 * Activity ingestion.
 *
 * Idempotency rests on the `(user_id, client_session_id)` unique constraint
 * built in P2: CLAUDE.md §26 requires the extension to buffer and retry when
 * the API is unavailable, so a replayed batch must be a no-op rather than a
 * source of duplicate rows that would inflate continuous-work totals.
 *
 * Decision D26: sessions are stored exactly as the extension aggregated them.
 * Nothing is merged or rewritten server-side — the ten-minute continuity rule
 * is applied during derivation in P5, where it cannot interfere with
 * idempotency.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors.js';
import type { ValidatedSession } from '../schemas/activity.js';

export interface IngestResult {
  readonly accepted: number;
  readonly duplicates: number;
}

interface ActivityRow {
  readonly user_id: string;
  readonly client_session_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly active_seconds: number;
  readonly domain: string | null;
}

/**
 * Within a single batch the extension may repeat a `clientSessionId`. Postgres
 * cannot upsert the same key twice in one statement, so duplicates are
 * collapsed here first and counted as duplicates in the result.
 */
function dedupeWithinBatch(
  userId: string,
  sessions: readonly ValidatedSession[],
): ActivityRow[] {
  const byKey = new Map<string, ActivityRow>();

  for (const session of sessions) {
    if (byKey.has(session.clientSessionId)) {
      continue;
    }
    byKey.set(session.clientSessionId, {
      user_id: userId,
      client_session_id: session.clientSessionId,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: new Date(session.endedAt).toISOString(),
      active_seconds: session.activeSeconds,
      domain: session.domain ?? null,
    });
  }

  return [...byKey.values()];
}

/**
 * Store a batch of aggregated sessions.
 *
 * `user_id` is supplied by the caller from the authenticated request context
 * and is never read from the request body, so a client cannot submit activity
 * on another user's behalf.
 *
 * Timestamps are normalised to UTC ISO strings before they are written
 * (CLAUDE.md §28).
 */
export async function ingestSessions(
  admin: SupabaseClient,
  userId: string,
  sessions: readonly ValidatedSession[],
): Promise<IngestResult> {
  const rows = dedupeWithinBatch(userId, sessions);

  // ignoreDuplicates turns a replay into a no-op: the existing row is left
  // exactly as it was, so re-sending a batch can never alter stored activity.
  const { data, error } = await admin
    .from('activity_sessions')
    .upsert(rows, {
      onConflict: 'user_id,client_session_id',
      ignoreDuplicates: true,
    })
    .select('client_session_id');

  if (error !== null) {
    // The underlying message names tables and constraints (CLAUDE.md §31).
    throw new ApiError('INTERNAL', 'Activity could not be stored.');
  }

  const accepted = data?.length ?? 0;
  return {
    accepted,
    duplicates: sessions.length - accepted,
  };
}
