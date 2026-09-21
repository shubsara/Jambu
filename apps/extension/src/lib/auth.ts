/**
 * Sign-in and sign-out (decision D58 — sign-in only in P8).
 *
 * Registration and onboarding belong to P12. The P3 contract note about a
 * registration response carrying no session therefore carries forward to P12
 * as well; nothing here registers.
 */
import { publicRequest, type ApiClientDeps } from './api-client.js';
import { clearSession, readProfile, saveSession, type StoredProfile } from './storage.js';

interface SignInResponse {
  readonly user: StoredProfile;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

export async function signIn(
  email: string,
  password: string,
  deps?: ApiClientDeps,
): Promise<StoredProfile> {
  const result = await publicRequest<SignInResponse>(
    '/api/auth/login',
    { email, password },
    deps,
  );

  await saveSession({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessExpiresAt: Date.parse(result.expiresAt),
    profile: result.user,
  });

  return result.user;
}

export async function signOut(): Promise<void> {
  await clearSession();
}

export { readProfile };
