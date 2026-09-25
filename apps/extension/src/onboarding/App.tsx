/**
 * Onboarding (decisions D85-D95).
 *
 * Four steps, two required inputs, under two minutes (D95). The flow asks for
 * a timezone and four toggles and nothing else — no lunch time, no water or
 * break schedule, no work hours (D88), no persona (D10) and no name (A6).
 * Those are not merely unasked: `OnboardingState` has no field for them.
 *
 * Tone follows §39: warm, calm, no progress anxiety, nothing red. Skipping is
 * offered on every step and costs the user nothing (D92).
 */
import { useEffect, useState, type ReactElement } from 'react';

import { SessionExpiredError } from '../lib/api-client.js';
import { submitOnboarding } from '../lib/preferences.js';
import { registerAccount } from '../lib/register.js';
import {
  clearOnboardingProgress,
  hasSession,
  readOnboardingProgress,
  saveOnboardingProgress,
} from '../lib/storage.js';
import {
  back,
  detectTimezone,
  fromProgress,
  initialState,
  next,
  toProgress,
  toSubmission,
  toggle,
  withTimezone,
  type OnboardingState,
  type ToggleId,
} from './machine.js';

type Phase = 'loading' | 'running' | 'verify-email' | 'done' | 'skipped';

const CHECK_INS: readonly { id: ToggleId; label: string; hint: string }[] = [
  {
    id: 'lunchEnabled',
    label: 'Lunch',
    hint: 'A nudge if you seem to have worked through it',
  },
  { id: 'breakEnabled', label: 'Breaks', hint: 'After a long stretch at the screen' },
  { id: 'hydrationEnabled', label: 'Water', hint: 'Off unless you want it' },
  {
    id: 'endDayEnabled',
    label: 'End of day',
    hint: 'When it looks like you should stop',
  },
];

export function App(): ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [state, setState] = useState<OnboardingState>(() =>
    initialState(detectTimezone()),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resume where the user left off (D92). A returning user who already has a
  // session skips the account step — this is also the A3 resume path.
  useEffect(() => {
    void (async () => {
      const progress = await readOnboardingProgress();
      const restored = fromProgress(progress, detectTimezone());
      const signedIn = await hasSession();

      setState(
        signedIn && restored.step === 'account'
          ? { ...restored, step: 'timezone' }
          : restored,
      );
      setPhase('running');
    })();
  }, []);

  async function advance(updated: OnboardingState): Promise<void> {
    setState(updated);
    await saveOnboardingProgress(toProgress(updated));
  }

  function describe(cause: unknown): string {
    if (cause instanceof SessionExpiredError) return 'Please sign in again.';
    return cause instanceof Error
      ? cause.message
      : 'Something went wrong. Please try again.';
  }

  async function handleAccount(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await registerAccount(email.trim(), password, state.timezone);
      setPassword('');

      if (result.kind === 'needs-verification') {
        // Resolution A3 — the account exists but there is no session, so
        // onboarding stops. Progress is already saved; signing in resumes it.
        await saveOnboardingProgress(toProgress({ ...state, step: 'timezone' }));
        setPhase('verify-email');
        return;
      }
      await advance(next(state));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await submitOnboarding(toSubmission(state));
      await clearOnboardingProgress();
      setPhase('done');
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip(): Promise<void> {
    // D92/D93 — skipping leaves onboarding incomplete on purpose, so nothing
    // is tracked. Progress stays so the popup can offer the way back.
    await saveOnboardingProgress(toProgress(state));
    setPhase('skipped');
  }

  const shell = (children: ReactElement): ReactElement => (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 bg-stone-50 p-8 font-sans text-stone-800">
      {children}
    </main>
  );

  if (phase === 'loading') {
    return shell(<p className="text-sm text-stone-500">One moment…</p>);
  }

  if (phase === 'verify-email') {
    return shell(
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Almost there</h1>
        <p className="text-sm text-stone-600">
          Your account is created. Please confirm your email, then sign in from the Jambu
          icon — I&apos;ll pick up right where we left off.
        </p>
      </section>,
    );
  }

  if (phase === 'done') {
    return shell(
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">That&apos;s it ❤️</h1>
        <p className="text-sm text-stone-600">
          I&apos;ll keep an eye out while you work. You can close this tab.
        </p>
      </section>,
    );
  }

  if (phase === 'skipped') {
    return shell(
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">No rush</h1>
        <p className="text-sm text-stone-600">
          I won&apos;t watch anything until you finish setting me up. Whenever you&apos;re
          ready, click the Jambu icon and pick up where you left off.
        </p>
      </section>,
    );
  }

  return shell(
    <>
      {state.step === 'welcome' ? (
        <section className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Hi, I&apos;m Jambu ❤️</h1>
          <p className="text-sm text-stone-600">
            I&apos;ll look out for you while you work — a quiet check-in when it looks
            like you could use one.
          </p>
          <p className="text-sm text-stone-600">
            I notice <strong>how long</strong> you&apos;ve been working, never what
            you&apos;re working on. No page contents, no keystrokes, nothing you type.
          </p>
          <button
            type="button"
            onClick={() => void advance(next(state))}
            className="mt-2 self-start rounded-lg bg-stone-800 px-4 py-2 text-sm text-stone-50"
          >
            Get started
          </button>
        </section>
      ) : null}

      {state.step === 'account' ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleAccount(e)}>
          <h1 className="text-xl font-semibold tracking-tight">Your account</h1>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-stone-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-stone-300 px-3 py-2"
            />
          </label>
          {error !== null ? (
            <p className="text-sm text-stone-700" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 self-start rounded-lg bg-stone-800 px-4 py-2 text-sm text-stone-50 disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      ) : null}

      {state.step === 'timezone' ? (
        <section className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Where are you?</h1>
          <p className="text-sm text-stone-600">
            So I check in at times that make sense for your day.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Timezone
            <input
              type="text"
              value={state.timezone}
              onChange={(e) => setState(withTimezone(state, e.target.value))}
              className="rounded-lg border border-stone-300 px-3 py-2"
            />
          </label>
          <button
            type="button"
            onClick={() => void advance(next(state))}
            className="mt-1 self-start rounded-lg bg-stone-800 px-4 py-2 text-sm text-stone-50"
          >
            That&apos;s right
          </button>
        </section>
      ) : null}

      {state.step === 'checkins' ? (
        <section className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            What should I check in about?
          </h1>
          <p className="text-sm text-stone-600">
            These are already set sensibly — change them only if you want to.
          </p>
          <ul className="flex flex-col gap-2">
            {CHECK_INS.map((item) => (
              <li key={item.id}>
                <label className="flex items-start gap-3 rounded-lg border border-stone-200 bg-white p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={state[item.id]}
                    onChange={() => void advance(toggle(state, item.id))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{item.label}</span>
                    <span className="block text-stone-500">{item.hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {error !== null ? (
            <p className="text-sm text-stone-700" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleFinish()}
            className="mt-1 self-start rounded-lg bg-stone-800 px-4 py-2 text-sm text-stone-50 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Done'}
          </button>
        </section>
      ) : null}

      <div className="flex items-center gap-4 text-sm">
        {state.step !== 'welcome' ? (
          <button
            type="button"
            onClick={() => void advance(back(state))}
            className="text-stone-500 underline underline-offset-4"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleSkip()}
          className="text-stone-500 underline underline-offset-4"
        >
          Skip for now
        </button>
      </div>
    </>,
  );
}
