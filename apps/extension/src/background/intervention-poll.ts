/**
 * The D4 fallback path (decision D73, ARCHITECTURE.md §5.2).
 *
 * The primary path rides the activity-sync response. This poll covers what
 * that misses: an idle user posting no activity, a sync that failed, or a
 * worker terminated mid-cycle.
 *
 * It reuses P9's existing five-minute alarm rather than adding a second one,
 * so there is exactly one scheduling cadence in the extension.
 */
import { type ApiClientDeps, authedRequest } from '../lib/api-client.js';
import { hasSession } from '../lib/storage.js';
import { deliverFirst, type PendingIntervention } from './notification-orchestrator.js';

interface TodayResponse {
  readonly interventions: readonly (PendingIntervention & {
    readonly response: string | null;
  })[];
}

/** Fetch today's interventions and deliver any that are still unanswered. */
export async function pollInterventions(
  now: Date,
  deps?: ApiClientDeps,
): Promise<'delivered' | 'nothing' | 'skipped'> {
  if (!(await hasSession())) {
    return 'skipped';
  }

  try {
    const result = await authedRequest<TodayResponse>(
      '/api/interventions/today',
      { method: 'GET' },
      ...(deps === undefined ? [] : ([deps] as const)),
    );

    const unanswered = result.interventions.filter(
      (intervention) =>
        intervention.response === null &&
        Date.parse(intervention.expiresAt) > now.getTime(),
    );

    if (unanswered.length === 0) {
      return 'nothing';
    }

    const delivered = await deliverFirst(unanswered, now);
    return delivered === null ? 'nothing' : 'delivered';
  } catch {
    // An outage here costs one missed check; the next tick tries again.
    return 'nothing';
  }
}
