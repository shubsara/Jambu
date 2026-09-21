/**
 * API client (decisions D54, D56, CLAUDE.md §26).
 *
 * Three behaviours worth stating plainly, because each exists to avoid a
 * specific failure:
 *
 *  - **Backoff, bounded.** A backend outage must not turn into a retry storm,
 *    and must not retry forever (§26).
 *  - **Single-flight refresh.** Several requests hitting 401 at once must
 *    share one refresh. Otherwise they race, and every loser writes a stale
 *    token over the winner's.
 *  - **No refresh recursion.** A refresh that 401s never triggers another
 *    refresh; the session is cleared and the user is routed to sign-in.
 *
 * Nothing here logs tokens, Authorization headers or auth response bodies.
 */
import {
  clearSession,
  readAccessToken,
  readRefreshToken,
  saveRefreshedTokens,
} from './storage.js';

/** Build-time configuration (decision D57). The only compiled-in value. */
const API_BASE_URL: string =
  import.meta.env.VITE_JAMBU_API_BASE_URL ?? 'http://127.0.0.1:3000';

/** Refresh proactively when the access token has under this long to live. */
export const PROACTIVE_REFRESH_WINDOW_MS = 60_000;

/** §26 backoff: bounded attempts, growing delay, hard ceiling. */
export const RETRY_SCHEDULE_MS = [500, 2_000, 8_000] as const;

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;

  public constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

/** Raised when the session cannot be recovered and the user must sign in. */
export class SessionExpiredError extends Error {
  public constructor() {
    super('Your session has expired. Please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

export interface ApiClientDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Injected so tests do not wait out real backoff delays. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const defaultDeps: ApiClientDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) =>
    new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
};

function isRetryable(status: number): boolean {
  // 429 and 5xx are worth waiting out; a 4xx is our mistake and will not fix
  // itself by being sent again.
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * The in-flight refresh, if one is running.
 *
 * Module scope is deliberate and safe: if the service worker is terminated
 * mid-refresh the promise dies with it, and the next request simply starts a
 * new one. Nothing durable depends on it.
 */
let inFlightRefresh: Promise<string> | null = null;

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

async function requestRaw(
  path: string,
  init: RequestInit,
  deps: ApiClientDeps,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_SCHEDULE_MS.length; attempt += 1) {
    try {
      const response = await deps.fetch(`${API_BASE_URL}${path}`, init);
      if (!isRetryable(response.status) || attempt === RETRY_SCHEDULE_MS.length) {
        return response;
      }
      lastError = new ApiClientError(response.status, 'The service is busy.');
    } catch (cause) {
      // Network failure: the API is unreachable, which §26 says must not break
      // the extension. It is retryable, up to the same bounded schedule.
      lastError = cause;
      if (attempt === RETRY_SCHEDULE_MS.length) {
        break;
      }
    }

    await deps.sleep(RETRY_SCHEDULE_MS[attempt] as number);
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiClientError(0, 'The service is unavailable.');
}

/**
 * Exchange the refresh token for a new session.
 *
 * Collapses concurrent callers onto one request, and never refreshes in
 * response to its own failure.
 */
async function refreshSession(deps: ApiClientDeps): Promise<string> {
  if (inFlightRefresh !== null) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async (): Promise<string> => {
    const refreshToken = await readRefreshToken();
    if (refreshToken === null) {
      await clearSession();
      throw new SessionExpiredError();
    }

    const response = await requestRaw(
      '/api/auth/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      deps,
    );

    if (!response.ok) {
      // Terminal. Clearing the session is what stops a refresh loop.
      await clearSession();
      throw new SessionExpiredError();
    }

    const tokens = (await response.json()) as TokenResponse;
    await saveRefreshedTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: Date.parse(tokens.expiresAt),
    });
    return tokens.accessToken;
  })().finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}

/** An access token good for the next call, refreshing first if it is about to expire. */
async function currentAccessToken(deps: ApiClientDeps): Promise<string> {
  const stored = await readAccessToken();
  if (stored !== null && stored.expiresAt - deps.now() > PROACTIVE_REFRESH_WINDOW_MS) {
    return stored.token;
  }
  return refreshSession(deps);
}

async function readError(response: Response): Promise<ApiClientError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    return new ApiClientError(
      response.status,
      body.error?.message ?? 'The request could not be completed.',
      body.error?.code,
    );
  } catch {
    return new ApiClientError(response.status, 'The request could not be completed.');
  }
}

/** An unauthenticated call, used for sign-in. */
export async function publicRequest<T>(
  path: string,
  body: unknown,
  deps: ApiClientDeps = defaultDeps,
): Promise<T> {
  const response = await requestRaw(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    deps,
  );

  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as T;
}

/**
 * An authenticated call.
 *
 * Refreshes proactively, and once reactively on a 401. A second 401 after a
 * successful refresh is not retried again — that would be the loop D56 forbids.
 */
export async function authedRequest<T>(
  path: string,
  init: RequestInit = {},
  deps: ApiClientDeps = defaultDeps,
): Promise<T> {
  const token = await currentAccessToken(deps);

  const send = (bearer: string): Promise<Response> =>
    requestRaw(
      path,
      {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${bearer}`,
        },
      },
      deps,
    );

  let response = await send(token);

  if (response.status === 401) {
    const refreshed = await refreshSession(deps);
    response = await send(refreshed);
    if (response.status === 401) {
      await clearSession();
      throw new SessionExpiredError();
    }
  }

  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as T;
}

/** Exposed for tests; resets the single-flight latch between cases. */
export function __resetRefreshState(): void {
  inFlightRefresh = null;
}

export { API_BASE_URL };
