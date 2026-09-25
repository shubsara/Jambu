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
const ONBOARDING_PROGRESS_KEY = 'onboarding.progress';
const ONBOARDING_COMPLETE_KEY = 'onboarding.completedAt';
const PENDING_VIEW_KEY = 'options.pendingView';

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

/**
 * Forget everything. Used on sign-out and on an unrecoverable refresh.
 *
 * The onboarding cache and any half-finished progress go too: both belong to
 * the user who just left, and leaving the completion cache behind would let
 * the next person's session start tracking before the server had agreed (D93).
 */
export async function clearSession(): Promise<void> {
  await Promise.all([
    removeFrom(sessionArea(), [ACCESS_TOKEN_KEY, ACCESS_EXPIRES_KEY, PENDING_VIEW_KEY]),
    removeFrom(localArea(), [
      REFRESH_TOKEN_KEY,
      PROFILE_KEY,
      ONBOARDING_PROGRESS_KEY,
      ONBOARDING_COMPLETE_KEY,
    ]),
  ]);
}

/**
 * Onboarding progress (decision D92).
 *
 * Kept in `local` so a half-finished flow survives closing the tab, and
 * deliberately narrow: a step index and four booleans plus a timezone. There
 * is **no** field here for a lunch time, water schedule, break schedule or
 * work hours (D88, constraint 7) — the shape is the guard, so a schedule
 * question could not be persisted even if someone added the input.
 */
export interface OnboardingProgress {
  readonly step: number;
  readonly timezone?: string;
  readonly lunchEnabled?: boolean;
  readonly breakEnabled?: boolean;
  readonly hydrationEnabled?: boolean;
  readonly endDayEnabled?: boolean;
}

export async function saveOnboardingProgress(
  progress: OnboardingProgress,
): Promise<void> {
  await writeTo(localArea(), { [ONBOARDING_PROGRESS_KEY]: progress });
}

export async function readOnboardingProgress(): Promise<OnboardingProgress | null> {
  const stored = await readFrom(localArea(), ONBOARDING_PROGRESS_KEY);
  return stored === undefined || stored === null ? null : (stored as OnboardingProgress);
}

export async function clearOnboardingProgress(): Promise<void> {
  await removeFrom(localArea(), [ONBOARDING_PROGRESS_KEY]);
}

/**
 * A cache of the server's `onboardingCompletedAt` (resolution A1).
 *
 * The server is authoritative (D86). This exists only so the service worker
 * can answer "may I track?" without a network round trip on every tab event —
 * and it is written from a server response, never inferred locally.
 */
export async function cacheOnboardingCompletedAt(value: string | null): Promise<void> {
  if (value === null) {
    await removeFrom(localArea(), [ONBOARDING_COMPLETE_KEY]);
    return;
  }
  await writeTo(localArea(), { [ONBOARDING_COMPLETE_KEY]: value });
}

export async function readCachedOnboardingCompletedAt(): Promise<string | null> {
  const stored = await readFrom(localArea(), ONBOARDING_COMPLETE_KEY);
  return typeof stored === 'string' ? stored : null;
}

/**
 * Where the popup is asking the options page to open (decision D97).
 *
 * The popup and the options page are separate documents, and
 * `chrome.runtime.openOptionsPage()` takes no arguments — it cannot carry a
 * destination. So the popup leaves one here and the options page picks it up.
 *
 * `session` rather than `local`: a navigation intent is meaningless after the
 * browser restarts, and it should not outlive the click that made it.
 */
export type PendingOptionsView = 'export' | 'delete-activity' | 'delete-account';

const PENDING_VIEWS: readonly PendingOptionsView[] = [
  'export',
  'delete-activity',
  'delete-account',
];

export async function savePendingOptionsView(view: PendingOptionsView): Promise<void> {
  await writeTo(sessionArea(), { [PENDING_VIEW_KEY]: view });
}

/**
 * Read the pending view **and clear it**, so it can never fire twice.
 *
 * Clearing happens whatever was stored, including an unrecognised value: a
 * target that is ignored but left in place would sit waiting to surprise the
 * next visit. Anything outside the allowlist returns `null`.
 */
export async function takePendingOptionsView(): Promise<PendingOptionsView | null> {
  const stored = await readFrom(sessionArea(), PENDING_VIEW_KEY);
  await removeFrom(sessionArea(), [PENDING_VIEW_KEY]);

  return PENDING_VIEWS.includes(stored as PendingOptionsView)
    ? (stored as PendingOptionsView)
    : null;
}

/** Exposed for tests that need to assert the storage split. */
export const STORAGE_KEYS = {
  accessToken: ACCESS_TOKEN_KEY,
  accessExpiresAt: ACCESS_EXPIRES_KEY,
  refreshToken: REFRESH_TOKEN_KEY,
  profile: PROFILE_KEY,
  onboardingProgress: ONBOARDING_PROGRESS_KEY,
  onboardingCompletedAt: ONBOARDING_COMPLETE_KEY,
  pendingOptionsView: PENDING_VIEW_KEY,
} as const;
