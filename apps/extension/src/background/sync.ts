/**
 * Batched synchronisation (CLAUDE.md §11, §26; decisions D63, D64).
 *
 * Sync is batched, never per-event. A failure keeps the sessions buffered so a
 * backend outage costs nothing but delay — which is what §26 asks for.
 *
 * Retry discipline, deliberately in two layers rather than a new mechanism:
 *
 *  - **Within an attempt**, the API client already backs off on 429/5xx and
 *    network errors on a bounded schedule, then gives up.
 *  - **Between attempts**, the 5-minute alarm is the outer retry. It is slow
 *    by construction, so no additional backoff constant was invented.
 *
 * A batch rejected as invalid is dropped rather than retried forever: a 400
 * will never succeed, and re-sending it would be the storm §26 forbids.
 */
import { MAX_ACTIVITY_SESSIONS_PER_BATCH } from '@jambu/shared-types';

import {
  ApiClientError,
  SessionExpiredError,
  authedRequest,
  type ApiClientDeps,
} from '../lib/api-client.js';
import { hasSession } from '../lib/storage.js';
import { readBuffer, removeSessions, type BufferedSession } from './activity-buffer.js';

export type SyncOutcome =
  | { readonly status: 'idle'; readonly reason: 'empty' | 'signed-out' }
  | { readonly status: 'synced'; readonly accepted: number; readonly duplicates: number }
  | { readonly status: 'deferred' }
  | { readonly status: 'discarded'; readonly count: number };

interface IngestResponse {
  readonly accepted: number;
  readonly duplicates: number;
  // Decision D63: P9 ignores this. P10 owns intervention presentation.
  readonly pendingInterventions?: unknown[];
}

/** The payload, built so only domains and durations can leave the browser. */
function toPayload(sessions: readonly BufferedSession[]): {
  sessions: Record<string, unknown>[];
} {
  return {
    sessions: sessions.map((session) => ({
      clientSessionId: session.clientSessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activeSeconds: session.activeSeconds,
      // Omitted entirely when null, rather than sent as null.
      ...(session.domain === null ? {} : { domain: session.domain }),
    })),
  };
}

/**
 * Flush the buffer.
 *
 * Chunked to the shared ingest maximum so one oversized backlog cannot produce
 * a request the API is bound to refuse.
 */
export async function syncBufferedActivity(deps?: ApiClientDeps): Promise<SyncOutcome> {
  if (!(await hasSession())) {
    // Nothing to sync against. The sessions stay buffered for after sign-in.
    return { status: 'idle', reason: 'signed-out' };
  }

  const buffered = await readBuffer();
  if (buffered.length === 0) {
    return { status: 'idle', reason: 'empty' };
  }

  const batch = buffered.slice(0, MAX_ACTIVITY_SESSIONS_PER_BATCH);

  try {
    const result = await authedRequest<IngestResponse>(
      '/api/activity/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toPayload(batch)),
      },
      // Injectable so tests need not wait out the real backoff schedule.
      ...(deps === undefined ? [] : ([deps] as const)),
    );

    // Duplicates are a successful outcome: the API accepted them once already,
    // so they must leave the buffer too (CLAUDE.md §26).
    await removeSessions(batch.map((session) => session.clientSessionId));

    return {
      status: 'synced',
      accepted: result.accepted,
      duplicates: result.duplicates,
    };
  } catch (cause) {
    if (cause instanceof ApiClientError && cause.status === 400) {
      // Permanently unacceptable. Retrying cannot help, and keeping it would
      // block every later session behind it.
      await removeSessions(batch.map((session) => session.clientSessionId));
      return { status: 'discarded', count: batch.length };
    }

    if (cause instanceof SessionExpiredError) {
      // Sign-in is required; the buffer is untouched and waits.
      return { status: 'deferred' };
    }

    // Outage, throttling or network failure: keep everything and let the
    // alarm try again later.
    return { status: 'deferred' };
  }
}
