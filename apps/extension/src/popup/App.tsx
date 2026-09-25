/**
 * Popup (board screens 2, 4 and 5).
 *
 * CLAUDE.md §10: no business-critical logic lives here. The popup may not even
 * be open when Jambu needs to act, so it reads state and calls the API — it
 * decides nothing. It shows whether Jambu is watching or paused, offers the
 * pause durations (D98), and leads to the options page for everything else.
 *
 * It also keeps the two entry points earlier phases put here: "Create account"
 * for signed-out users (D96) and "Finish setup" when onboarding is unfinished
 * (D92), because D93 means Jambu is watching nothing until that is done.
 *
 * Tone follows §39: warm, calm, unobtrusive. The only red belongs to deletion,
 * and that lives on the options page behind a typed confirmation.
 */
import { useEffect, useState, type ReactElement } from 'react';

import { openExtensionPage, openOnboarding } from '../background/tracking-gate.js';
import { SessionExpiredError } from '../lib/api-client.js';
import { readProfile, signIn, signOut } from '../lib/auth.js';
import {
  PAUSE_CHOICES,
  endPause,
  fetchPause,
  startPause,
  type PauseState,
} from '../lib/control.js';
import { fetchPreferences } from '../lib/preferences.js';
import {
  hasSession,
  savePendingOptionsView,
  type PendingOptionsView,
  type StoredProfile,
} from '../lib/storage.js';
import { Callout, Modal, Row, formatWhen } from '../ui/components.js';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'submitting';

/** Must match `options_ui.page` in the manifest. */
const OPTIONS_PAGE = 'options/index.html';

/**
 * Open the settings page (decision D97). No permission required.
 *
 * The previous version was `chrome?.runtime?.openOptionsPage?.()`, which
 * silenced every way this can fail: the optional call swallowed a missing
 * API, and without a callback `chrome.runtime.lastError` was never read — so
 * an extension loaded before `options_ui` existed in the manifest simply did
 * nothing, with no error anywhere. Clicking Settings produced no response.
 *
 * Now the failure is both reported and recovered from: `lastError` is read,
 * and the page is opened through the same `chrome.tabs.create` path that
 * already works for onboarding.
 */
function openSettings(): void {
  const runtime = globalThis.chrome?.runtime;

  if (typeof runtime?.openOptionsPage !== 'function') {
    void openExtensionPage(OPTIONS_PAGE);
    return;
  }

  runtime.openOptionsPage(() => {
    // Reading `lastError` is the only way a failure becomes visible at all.
    if (runtime.lastError !== undefined) {
      void openExtensionPage(OPTIONS_PAGE);
    }
  });
}

/**
 * Open settings at a particular flow.
 *
 * `openOptionsPage()` takes no arguments, so the destination is left in
 * session storage for the options page to pick up. Without this every row
 * here opened the same default page, and "Delete my account" behaved
 * identically to "Settings".
 */
function openSettingsAt(view: PendingOptionsView): void {
  void savePendingOptionsView(view).then(openSettings, openSettings);
}

export function App(): ReactElement {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [pause, setPause] = useState<PauseState | null>(null);
  const [workEnd, setWorkEnd] = useState('18:00');
  const [showPause, setShowPause] = useState(false);
  const [busy, setBusy] = useState(false);

  // Decision D53: a missing refresh token after a restart means sign-in, not
  // a half-signed-in state.
  useEffect(() => {
    void (async () => {
      const signedIn = await hasSession();
      setProfile(signedIn ? await readProfile() : null);
      setStatus(signedIn ? 'signed-in' : 'signed-out');

      if (!signedIn) {
        return;
      }
      // D93 — an unfinished setup is surfaced here so a user who skipped (D92)
      // has a way back. A failure leaves the state unknown and shows nothing
      // rather than guessing.
      try {
        const preferences = await fetchPreferences();
        setOnboarded(preferences.onboardingCompletedAt !== null);
        setWorkEnd(preferences.workEnd);
        setPause(await fetchPause());
      } catch {
        setOnboarded(null);
      }
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
    setPause(null);
    setStatus('signed-out');
  }

  async function changePause(work: () => Promise<PauseState>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPause(await work());
      setShowPause(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const paused = pause?.paused === true;

  return (
    <main className="jambu-canvas w-80 p-4">
      <header className="mb-3 flex items-center gap-2 px-1">
        <span aria-hidden>🌱</span>
        <h1 className="flex-1 text-base font-semibold tracking-tight">Jambu</h1>
        {status === 'signed-in' ? (
          <button
            type="button"
            onClick={openSettings}
            aria-label="Settings"
            data-testid="open-settings"
            className="rounded-lg px-1.5 py-1 text-base"
            style={{ color: 'var(--jambu-ink-muted)' }}
          >
            ⚙
          </button>
        ) : null}
      </header>

      {status === 'loading' ? (
        <p className="px-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
          One moment…
        </p>
      ) : status === 'signed-in' ? (
        <section>
          {paused ? (
            <div className="jambu-card p-4" data-testid="paused-card">
              <p className="text-center text-sm font-semibold">Reminders paused</p>
              <p
                className="mt-0.5 text-center text-xs"
                style={{ color: 'var(--jambu-ink-muted)' }}
              >
                Until {formatWhen(pause?.pausedUntil ?? null)}
              </p>
              <div className="mt-3">
                <Callout>
                  You won&apos;t see reminder cards during this time. Your activity will
                  still be tracked.
                </Callout>
              </div>
              <button
                type="button"
                disabled={busy}
                data-testid="resume-reminders"
                onClick={() => void changePause(endPause)}
                className="jambu-button jambu-button-quiet mt-3 w-full"
              >
                ▶ Resume reminders
              </button>
            </div>
          ) : (
            <div
              className="rounded-xl p-3"
              style={{ background: 'var(--jambu-green-soft)' }}
              data-testid="active-card"
            >
              <p
                className="flex items-center gap-2 text-sm font-semibold"
                style={{ color: 'var(--jambu-green-deep)' }}
              >
                <span aria-hidden>●</span> Active
              </p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--jambu-ink-muted)' }}>
                Watching for patterns to support your wellbeing.
              </p>
            </div>
          )}

          {onboarded === false ? (
            <div className="jambu-card mt-3 p-3">
              <p
                className="text-sm"
                style={{ color: 'var(--jambu-ink-muted)' }}
                data-testid="resume-onboarding-note"
              >
                I&apos;m not watching anything yet — finish setting me up whenever
                you&apos;re ready.
              </p>
              <button
                type="button"
                onClick={() => void openOnboarding()}
                className="jambu-button jambu-button-primary mt-2 w-full"
              >
                Finish setup
              </button>
            </div>
          ) : null}

          {error !== null ? (
            <p
              className="mt-3 text-sm"
              role="alert"
              style={{ color: 'var(--jambu-ink)' }}
            >
              {error}
            </p>
          ) : null}

          <ul className="mt-2 flex flex-col">
            {paused ? null : (
              <li>
                <Row
                  icon="⏸"
                  tone="blue"
                  label="Pause reminders"
                  testId="open-pause"
                  onClick={() => setShowPause(true)}
                  trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
                />
              </li>
            )}
            <li>
              <Row
                icon="⚙"
                tone="green"
                label="Settings"
                testId="row-settings"
                onClick={openSettings}
                trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
              />
            </li>
            <li>
              <Row
                icon="⬇"
                tone="warm"
                label="Export my data"
                testId="row-export"
                onClick={() => openSettingsAt('export')}
                trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
              />
            </li>
            <li>
              <Row
                icon="🗑"
                danger
                label="Delete my activity"
                testId="row-delete-activity"
                onClick={() => openSettingsAt('delete-activity')}
                trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
              />
            </li>
            <li>
              <Row
                icon="🗑"
                danger
                label="Delete my account"
                testId="row-delete-account"
                onClick={() => openSettingsAt('delete-account')}
                trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
              />
            </li>
          </ul>

          <p
            className="mt-3 truncate px-1 text-xs"
            style={{ color: 'var(--jambu-ink-faint)' }}
            data-testid="profile-email"
          >
            {profile?.email ?? '—'}
          </p>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="jambu-button jambu-button-quiet mt-2 w-full"
          >
            Sign out
          </button>
        </section>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--jambu-border-strong)' }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--jambu-border-strong)' }}
            />
          </label>

          {error !== null ? (
            <p className="text-sm" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="jambu-button jambu-button-primary"
          >
            {status === 'submitting' ? 'Signing in…' : 'Sign in'}
          </button>

          {/*
            Decision D96 — without this, registration is reachable only from
            the tab that opened itself at install time. Secondary by design:
            the form itself stays on the onboarding page (D85, D87).
          */}
          <p className="text-center text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
            New here?{' '}
            <button
              type="button"
              onClick={() => void openOnboarding()}
              data-testid="create-account"
              className="underline underline-offset-4"
            >
              Create account
            </button>
          </p>
        </form>
      )}

      {showPause ? (
        <Modal
          title="Pause reminders"
          onClose={() => setShowPause(false)}
          testId="pause-modal"
        >
          <p className="mb-3 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
            Take a break from Jambu&apos;s reminders. Your activity will still be tracked
            to learn your patterns.
          </p>
          <ul className="flex flex-col gap-1">
            {PAUSE_CHOICES.map((choice) => (
              <li key={choice.id}>
                <Row
                  icon={choice.id === 'rest-of-day' ? '🌇' : '🕘'}
                  tone={choice.id === 'rest-of-day' ? 'sun' : 'green'}
                  label={choice.label}
                  hint={formatWhen(choice.resolve(new Date(), workEnd).toISOString())}
                  testId={`pause-${choice.id}`}
                  onClick={() => {
                    if (!busy) {
                      void changePause(() =>
                        startPause(choice.resolve(new Date(), workEnd)),
                      );
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </main>
  );
}
