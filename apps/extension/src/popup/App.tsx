/**
 * Popup UI — sign-in only (decision D58).
 *
 * CLAUDE.md §10: no business-critical logic lives here. The popup may not even
 * be open when Jambu needs to act, so it only reads state and calls the two
 * functions in `lib/auth`. Registration and onboarding are P12; the care card
 * is P10.
 *
 * Tone follows §39: warm, calm, unobtrusive. No red alarm states.
 */
import { useEffect, useState, type ReactElement } from 'react';

import { SessionExpiredError } from '../lib/api-client.js';
import { readProfile, signIn, signOut } from '../lib/auth.js';
import { hasSession, type StoredProfile } from '../lib/storage.js';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'submitting';

export function App(): ReactElement {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Decision D53: a missing refresh token after a restart means sign-in, not
  // a half-signed-in state.
  useEffect(() => {
    void (async () => {
      const signedIn = await hasSession();
      setProfile(signedIn ? await readProfile() : null);
      setStatus(signedIn ? 'signed-in' : 'signed-out');
    })();
  }, []);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus('submitting');
    try {
      const signedIn = await signIn(email.trim(), password);
      setProfile(signedIn);
      setPassword('');
      setStatus('signed-in');
    } catch (cause) {
      // The API is the only source of truth about why. Its messages are
      // already written not to reveal whether an account exists.
      setError(
        cause instanceof SessionExpiredError
          ? 'Please sign in again.'
          : cause instanceof Error
            ? cause.message
            : 'Something went wrong. Please try again.',
      );
      setStatus('signed-out');
    }
  }

  async function handleSignOut(): Promise<void> {
    await signOut();
    setProfile(null);
    setStatus('signed-out');
  }

  return (
    <main className="w-80 bg-stone-50 p-5 font-sans text-stone-800">
      <h1 className="text-base font-semibold tracking-tight">Jambu</h1>

      {status === 'loading' ? (
        <p className="mt-3 text-sm text-stone-500">One moment…</p>
      ) : status === 'signed-in' ? (
        <section className="mt-3">
          <p className="text-sm text-stone-600">Signed in as</p>
          <p className="truncate text-sm font-medium" data-testid="profile-email">
            {profile?.email ?? '—'}
          </p>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="mt-4 rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
          >
            Sign out
          </button>
        </section>
      ) : (
        <form className="mt-3 flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-stone-300 px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-stone-300 px-2 py-1.5"
            />
          </label>

          {error !== null ? (
            <p className="text-sm text-stone-700" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="rounded-lg bg-stone-800 px-3 py-1.5 text-sm text-stone-50 disabled:opacity-60"
          >
            {status === 'submitting' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </main>
  );
}
