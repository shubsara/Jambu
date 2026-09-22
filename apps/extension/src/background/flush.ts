/**
 * The flush trigger (decision D64).
 *
 * Separated from `tabs.ts` and `sync.ts` so the buffer threshold lives in one
 * place and neither module has to know about the other.
 */
import type { ApiClientDeps } from '../lib/api-client.js';
import { shouldFlush } from './activity-buffer.js';
import { syncBufferedActivity } from './sync.js';

/** Sync early when the buffer has reached the threshold; otherwise wait for the alarm. */
export async function maybeFlush(deps?: ApiClientDeps): Promise<boolean> {
  if (!(await shouldFlush())) {
    return false;
  }
  await syncBufferedActivity(deps);
  return true;
}
