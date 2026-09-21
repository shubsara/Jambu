/**
 * Authentication storage (decision D53).
 *
 * The single place that touches storage keys. Application code asks for a
 * session; it never reaches for `chrome.storage` itself, so the split below
 * cannot drift.
 *
 *   refresh token, profile → chrome.storage.local    (survives restart)
 *   access token, expiry   → chrome.storage.session  (memory only)
 *
 * The short-lived access token is deliberately not written to disk. The
 * refresh token has to survive a browser restart or the user signs in every
 * morning, so it lives in `local` — and if it is missing after a restart the
 * caller routes back to sign-in rather than guessing.
 *
 * Nothing here logs. Tokens, storage contents and auth responses never reach a
 * log line (CLAUDE.md §31).
 */

const ACCESS_TOKEN_KEY = 'auth.accessToken';
const ACCESS_EXPIRES_KEY = 'auth.accessExpiresAt';
const REFRESH_TOKEN_KEY = 'auth.refreshToken';
const PROFILE_KEY = 'auth.profile';

/** The signed-in user, as the popup needs to display them. */
export interface StoredProfile {
  readonly id: string;
  readonly email: string;
  readonly name?: string | null;
}

export interface StoredSession {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
  readonly profile: StoredProfile;
}

/**
 * `chrome.storage.session` is unavailable in some contexts and in tests.
 * Falling back to `local` for the access token would put it on disk, which is
 * exactly what D53 avoids, so we fail closed to an in-memory map instead.
 */
const memoryFallback = new Map<string, unknown>();

function sessionArea(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.session ?? null;
}

function localArea(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

async function readFrom(
  area: chrome.storage.StorageArea | null,
  key: string,
): Promise<unknown> {
  if (area === null) {
    return memoryFallback.get(key);
  }
  const result = await area.get(key);
  return (result as Record<string, unknown>)[key];
}

async function writeTo(
  area: chrome.storage.StorageArea | null,
  values: Record<string, unknown>,
): Promise<void> {
  if (area === null) {
    for (const [key, value] of Object.entries(values)) {
      memoryFallback.set(key, value);
    }
    return;
  }
  await area.set(values);
}

async function removeFrom(
  area: chrome.storage.StorageArea | null,
  keys: string[],
): Promise<void> {
  if (area === null) {
    for (const key of keys) {
      memoryFallback.delete(key);
    }
    return;
  }
  await area.remove(keys);
}

/** Persist a freshly-issued session. */
export async function saveSession(session: StoredSession): Promise<void> {
  await Promise.all([
    writeTo(sessionArea(), {
      [ACCESS_TOKEN_KEY]: session.accessToken,
      [ACCESS_EXPIRES_KEY]: session.accessExpiresAt,
    }),
    writeTo(localArea(), {
      [REFRESH_TOKEN_KEY]: session.refreshToken,
      [PROFILE_KEY]: session.profile,
    }),
  ]);
}

/** Replace only the tokens, leaving the stored profile alone. */
export async function saveRefreshedTokens(tokens: {
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
}): Promise<void> {
  await Promise.all([
    writeTo(sessionArea(), {
      [ACCESS_TOKEN_KEY]: tokens.accessToken,
      [ACCESS_EXPIRES_KEY]: tokens.accessExpiresAt,
    }),
    writeTo(localArea(), { [REFRESH_TOKEN_KEY]: tokens.refreshToken }),
  ]);
}

export async function readAccessToken(): Promise<{
  token: string;
  expiresAt: number;
} | null> {
  const [token, expiresAt] = await Promise.all([
    readFrom(sessionArea(), ACCESS_TOKEN_KEY),
    readFrom(sessionArea(), ACCESS_EXPIRES_KEY),
  ]);
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    return null;
  }
  return { token, expiresAt };
}

export async function readRefreshToken(): Promise<string | null> {
  const token = await readFrom(localArea(), REFRESH_TOKEN_KEY);
  return typeof token === 'string' ? token : null;
}

export async function readProfile(): Promise<StoredProfile | null> {
  const profile = await readFrom(localArea(), PROFILE_KEY);
  return profile === undefined || profile === null ? null : (profile as StoredProfile);
}

/**
 * Whether the user should be treated as signed in.
 *
 * Keyed on the refresh token, not the access token: after a browser restart
 * the access token is gone by design, and the user should stay signed in.
 * With no refresh token there is nothing to recover from, so the caller routes
 * to sign-in.
 */
export async function hasSession(): Promise<boolean> {
  return (await readRefreshToken()) !== null;
}

/** Forget everything. Used on sign-out and on an unrecoverable refresh. */
export async function clearSession(): Promise<void> {
  await Promise.all([
    removeFrom(sessionArea(), [ACCESS_TOKEN_KEY, ACCESS_EXPIRES_KEY]),
    removeFrom(localArea(), [REFRESH_TOKEN_KEY, PROFILE_KEY]),
  ]);
}

/** Exposed for tests that need to assert the storage split. */
export const STORAGE_KEYS = {
  accessToken: ACCESS_TOKEN_KEY,
  accessExpiresAt: ACCESS_EXPIRES_KEY,
  refreshToken: REFRESH_TOKEN_KEY,
  profile: PROFILE_KEY,
} as const;
