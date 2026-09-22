/**
 * Background service worker.
 *
 * MV3 terminates an idle worker within about thirty seconds, so nothing here
 * may hold state in module scope and expect to find it later. Every answer is
 * read from `chrome.storage` at the moment it is needed, which is what makes
 * the worker restart-safe by construction rather than by careful bookkeeping.
 *
 * `setTimeout` is banned in this directory by lint: pending timers die with
 * the worker. Scheduling arrives with `chrome.alarms` in P9, along with the
 * permission to use it.
 */
import { hasSession, readProfile, type StoredProfile } from '../lib/storage.js';
import { registerAlarms } from './alarms.js';
import { registerIdleListeners } from './idle.js';
import { submitResponse, type CardResponseValue } from './response-submitter.js';
import { registerTabListeners } from './tabs.js';

/** What the popup asks the worker for. */
export type WorkerMessage = { readonly type: 'auth:state' };

export interface AuthState {
  readonly signedIn: boolean;
  readonly profile: StoredProfile | null;
}

/**
 * Resolve the current auth state.
 *
 * Deliberately reads storage on every call rather than caching: a cached value
 * would be wrong the first time the worker is revived, and right only by luck
 * thereafter.
 */
export async function resolveAuthState(): Promise<AuthState> {
  const signedIn = await hasSession();
  return {
    signedIn,
    profile: signedIn ? await readProfile() : null,
  };
}

export function registerListeners(runtime = globalThis.chrome?.runtime): void {
  if (runtime === undefined) {
    return;
  }

  runtime.onMessage?.addListener(
    (
      message: WorkerMessage,
      _sender: unknown,
      sendResponse: (value: AuthState) => void,
    ) => {
      if (message?.type !== 'auth:state') {
        return false;
      }
      void resolveAuthState().then(sendResponse);
      // Keeps the message channel open for the async reply.
      return true;
    },
  );
}

/**
 * Answers coming back from the Care Card.
 *
 * The message carries an intervention id and a response value and nothing
 * else; no page information crosses this boundary (CLAUDE.md §9).
 */
export function registerCardResponseListener(runtime = globalThis.chrome?.runtime): void {
  runtime?.onMessage?.addListener((message: unknown) => {
    const candidate = message as {
      type?: string;
      interventionId?: string;
      response?: CardResponseValue;
    };
    if (
      candidate?.type !== 'jambu:card-response' ||
      typeof candidate.interventionId !== 'string' ||
      candidate.response === undefined
    ) {
      return false;
    }
    void submitResponse(candidate.interventionId, candidate.response, new Date());
    return false;
  });
}

registerListeners();
registerCardResponseListener();

// P9: observe activity, detect idle, and schedule the batched flush. Each
// registration is a no-op when its API is unavailable, so the worker still
// loads in a context without them.
registerTabListeners();
registerIdleListeners();
registerAlarms();
