/**
 * Registration (decision D87 — the UI deferred here from P8 by D58).
 *
 * The case that shapes this module is resolution A3: the auth provider returns
 * a created user and **no tokens** when email confirmation is enabled, so
 * `POST /api/auth/register` answers `201 { user }` alone. That is a success,
 * not a failure, and the caller has to be able to tell the difference — hence
 * a discriminated result rather than a thrown error or a half-filled session.
 *
 * (The provider is deliberately unnamed here: the bundle secret scan rejects
 * that vendor name anywhere in built extension code, and a strict substring
 * rule is worth more than a comment's precision.)
 */
import { publicRequest, type ApiClientDeps } from './api-client.js';
import { saveSession, type StoredProfile } from './storage.js';

interface RegisterResponse {
  readonly user: StoredProfile;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

export type RegisterResult =
  /** Signed in and ready to continue onboarding. */
  | { readonly kind: 'signed-in'; readonly profile: StoredProfile }
  /** Account created, but the user must confirm their email first (A3). */
  | { readonly kind: 'needs-verification'; readonly profile: StoredProfile };

export async function registerAccount(
  email: string,
  password: string,
  timezone: string,
  deps?: ApiClientDeps,
): Promise<RegisterResult> {
  const result = await publicRequest<RegisterResponse>(
    '/api/auth/register',
    { email, password, timezone },
    deps,
  );

  // No tokens means email confirmation is on. The account exists; onboarding
  // stops here and resumes after sign-in from the progress already in storage.
  if (
    typeof result.accessToken !== 'string' ||
    typeof result.refreshToken !== 'string' ||
    typeof result.expiresAt !== 'string'
  ) {
    return { kind: 'needs-verification', profile: result.user };
  }

  await saveSession({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessExpiresAt: Date.parse(result.expiresAt),
    profile: result.user,
  });

  return { kind: 'signed-in', profile: result.user };
}
