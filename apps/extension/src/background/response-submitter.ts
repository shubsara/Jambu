/**
 * Submitting the user's answer (docs/API.md §8).
 *
 * The card sends back an id and a response value and nothing else. This
 * forwards exactly that.
 *
 * `snoozed` is what "Remind me later" produces; the server turns it into a
 * type-scoped snooze (decision D5), so a snoozed lunch does not silence
 * breaks.
 */
import { type ApiClientDeps, authedRequest } from '../lib/api-client.js';
import { forgetShown } from './shown-registry.js';

export type CardResponseValue = 'confirmed' | 'snoozed' | 'dismissed';

export async function submitResponse(
  interventionId: string,
  response: CardResponseValue,
  now: Date,
  deps?: ApiClientDeps,
): Promise<boolean> {
  try {
    await authedRequest(
      `/api/interventions/${interventionId}/response`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response }),
      },
      ...(deps === undefined ? [] : ([deps] as const)),
    );

    // Answered, so the duplicate guard no longer needs to hold it.
    await forgetShown(interventionId, now);
    return true;
  } catch {
    // The response is lost rather than retried: re-sending is safe (P7 is
    // idempotent), but there is nowhere to queue it that would not risk
    // replaying a stale answer after the card has gone.
    return false;
  }
}
