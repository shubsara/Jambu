/**
 * Settings (decision D97; board screens 6-10).
 *
 * The board's five sections, in its order: Reminders, Pause, Snoozes,
 * Privacy & data, Account. The visual language is the mockups'; the behaviour
 * is the approved D97-D107 contracts, and where the two disagree the decision
 * wins and the difference is recorded (ARCHITECTURE §14.5).
 *
 * Two such differences are visible here: the reminder list shows the four MVP
 * types rather than the board's Posture (see `intervention-meta.ts`), and the
 * pause list offers the four D98 durations rather than the board's "Custom
 * time" (see `PAUSE_CHOICES`).
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { InterventionType, PreferencesView } from '@jambu/shared-types';

import { SessionExpiredError } from '../lib/api-client.js';
import { signOut } from '../lib/auth.js';
import {
  PAUSE_CHOICES,
  clearSnooze,
  deleteAccount,
  deleteActivity,
  endPause,
  fetchDeletionRequest,
  fetchExport,
  fetchPause,
  fetchSnoozes,
  startPause,
  type PauseState,
  type SnoozeView,
} from '../lib/control.js';
import { fetchPreferences, updatePreferences } from '../lib/preferences.js';
import {
  hasSession,
  takePendingOptionsView,
  type PendingOptionsView,
} from '../lib/storage.js';
import { Callout, Modal, Row, Switch, formatWhen } from '../ui/components.js';
import { INTERVENTION_META, INTERVENTION_ORDER } from '../ui/intervention-meta.js';

type SectionId = 'reminders' | 'pause' | 'snoozes' | 'privacy' | 'account';

const SECTIONS: readonly { id: SectionId; label: string; icon: string }[] = [
  { id: 'reminders', label: 'Reminders', icon: '🍵' },
  { id: 'pause', label: 'Pause', icon: '⏸' },
  { id: 'snoozes', label: 'Snoozes', icon: '🕘' },
  { id: 'privacy', label: 'Privacy & data', icon: '🔒' },
  { id: 'account', label: 'Account', icon: '👤' },
];

type Dialog =
  | { kind: 'none' }
  | { kind: 'timezone' }
  | { kind: 'work-hours' }
  | { kind: 'export' }
  | { kind: 'delete-activity' }
  | { kind: 'delete-account' }
  | { kind: 'account-deleted' };

/**
 * Where each popup row lands (decision D97).
 *
 * A fixed map, so a stored value can only ever select one of these — never an
 * arbitrary section or dialog.
 */
const PENDING_DESTINATION: Readonly<
  Record<PendingOptionsView, { section: SectionId; dialog: Dialog['kind'] }>
> = {
  export: { section: 'privacy', dialog: 'export' },
  'delete-activity': { section: 'privacy', dialog: 'delete-activity' },
  'delete-account': { section: 'account', dialog: 'delete-account' },
};

function describe(cause: unknown): string {
  if (cause instanceof SessionExpiredError) return 'Please sign in again.';
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

export function App(): ReactElement {
  const [section, setSection] = useState<SectionId>('reminders');
  const [preferences, setPreferences] = useState<PreferencesView | null>(null);
  const [pause, setPause] = useState<PauseState | null>(null);
  const [snoozes, setSnoozes] = useState<SnoozeView[]>([]);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextPreferences, nextPause, nextSnoozes] = await Promise.all([
        fetchPreferences(),
        fetchPause(),
        fetchSnoozes(),
      ]);
      setPreferences(nextPreferences);
      setPause(nextPause);
      setSnoozes(nextSnoozes);
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const active = await hasSession();
      setSignedIn(active);
      if (!active) {
        return;
      }

      // The popup may have asked for a particular flow. Reading consumes it,
      // so it cannot fire again on the next visit, and anything outside the
      // allowlist is ignored.
      const pending = await takePendingOptionsView();
      if (pending !== null) {
        setSection(PENDING_DESTINATION[pending].section);
        setDialog({ kind: PENDING_DESTINATION[pending].dialog } as Dialog);
      }

      await reload();
    })();
  }, [reload]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Toggling a type re-reads snoozes as well as preferences: disabling one
   * clears its snooze server-side (D103), and the list on screen would
   * otherwise keep showing a snooze that no longer exists.
   */
  async function toggleType(type: InterventionType, next: boolean): Promise<void> {
    const key = INTERVENTION_META[type].preferenceKey;
    await run(async () => {
      setPreferences(await updatePreferences({ [key]: next }));
      setSnoozes(await fetchSnoozes());
    });
  }

  /**
   * Decision D107 — the completion message comes *before* the signed-out
   * screen, and replaces the page rather than floating over it.
   *
   * Deleting the account signs the user out, so the ordinary signed-out view
   * would otherwise swallow the confirmation and leave them looking at "Sign
   * in to Jambu" with no word about what just happened. There is also nothing
   * left to render behind a dialog: the settings it would cover are gone.
   */
  if (dialog.kind === 'account-deleted') {
    return (
      <main className="jambu-canvas grid min-h-screen place-items-center p-8">
        <div
          className="jambu-card max-w-sm p-6 text-center"
          data-testid="account-deleted"
        >
          <p className="text-3xl" aria-hidden>
            🌱
          </p>
          <h1 className="mt-2 text-lg font-semibold">Your account is deleted</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
            Everything Jambu held for you has been removed, and you are signed out on this
            device. Thank you for giving it a try. ❤️
          </p>
        </div>
      </main>
    );
  }

  if (signedIn === false) {
    return (
      <main className="jambu-canvas grid min-h-screen place-items-center p-8">
        <div className="jambu-card max-w-sm p-6 text-center">
          <h1 className="text-lg font-semibold">Sign in to Jambu</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
            Open the Jambu icon in your toolbar to sign in, then come back here.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="jambu-canvas min-h-screen p-6">
      <div className="jambu-card jambu-raised mx-auto flex max-w-4xl overflow-hidden">
        <nav
          className="w-56 flex-none border-r p-4"
          style={{ borderColor: 'var(--jambu-border)', background: '#f6f8f7' }}
          aria-label="Settings sections"
        >
          <p className="mb-4 flex items-center gap-2 px-2 text-base font-semibold">
            <span aria-hidden>🌱</span> Jambu
          </p>
          <ul className="flex flex-col gap-1">
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={section === item.id ? 'page' : undefined}
                  data-testid={`nav-${item.id}`}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
                  style={
                    section === item.id
                      ? {
                          background: 'var(--jambu-green-soft)',
                          color: 'var(--jambu-green-deep)',
                          fontWeight: 600,
                        }
                      : { color: 'var(--jambu-ink-muted)' }
                  }
                >
                  <span aria-hidden>{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="min-w-0 flex-1 p-6">
          {error !== null ? (
            <div className="mb-4">
              <Callout tone="danger">{error}</Callout>
            </div>
          ) : null}

          {section === 'reminders' ? (
            <Reminders
              preferences={preferences}
              busy={busy}
              onToggle={toggleType}
              onEditTimezone={() => setDialog({ kind: 'timezone' })}
              onEditWorkHours={() => setDialog({ kind: 'work-hours' })}
            />
          ) : null}

          {section === 'pause' ? (
            <Pause
              pause={pause}
              workEnd={preferences?.workEnd ?? '18:00'}
              busy={busy}
              onPause={(until) =>
                void run(async () => {
                  setPause(await startPause(until));
                })
              }
              onResume={() =>
                void run(async () => {
                  setPause(await endPause());
                })
              }
            />
          ) : null}

          {section === 'snoozes' ? (
            <Snoozes
              snoozes={snoozes}
              busy={busy}
              onClear={(type) =>
                void run(async () => {
                  setSnoozes(await clearSnooze(type));
                })
              }
            />
          ) : null}

          {section === 'privacy' ? (
            <Privacy
              onExport={() => setDialog({ kind: 'export' })}
              onDeleteActivity={() => setDialog({ kind: 'delete-activity' })}
            />
          ) : null}

          {section === 'account' ? (
            <Account onDeleteAccount={() => setDialog({ kind: 'delete-account' })} />
          ) : null}
        </section>
      </div>

      {dialog.kind === 'timezone' && preferences !== null ? (
        <ValueDialog
          title="Timezone"
          description="Jambu checks in at times that make sense where you are."
          initial={preferences.timezone}
          onClose={() => setDialog({ kind: 'none' })}
          onSave={(value) =>
            void run(async () => {
              setPreferences(await updatePreferences({ timezone: value }));
              setDialog({ kind: 'none' });
            })
          }
        />
      ) : null}

      {dialog.kind === 'work-hours' && preferences !== null ? (
        <WorkHoursDialog
          start={preferences.workStart}
          end={preferences.workEnd}
          onClose={() => setDialog({ kind: 'none' })}
          onSave={(workStart, workEnd) =>
            void run(async () => {
              setPreferences(await updatePreferences({ workStart, workEnd }));
              setDialog({ kind: 'none' });
            })
          }
        />
      ) : null}

      {dialog.kind === 'export' ? (
        <ExportDialog onClose={() => setDialog({ kind: 'none' })} />
      ) : null}

      {dialog.kind === 'delete-activity' ? (
        <DeleteDialog
          title="Delete activity data"
          body="This will permanently delete your activity history, routine patterns and intervention records."
          phrase="DELETE_ACTIVITY"
          action="Delete activity data"
          onClose={() => setDialog({ kind: 'none' })}
          onConfirm={async (phrase) => {
            const accepted = await deleteActivity(phrase);
            // Activity scope can be polled — the account survives (D104).
            for (let attempt = 0; attempt < 40; attempt += 1) {
              const status = await fetchDeletionRequest(accepted.deletionRequestId);
              if (status.status !== 'pending') break;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            await reload();
            setDialog({ kind: 'none' });
          }}
        />
      ) : null}

      {dialog.kind === 'delete-account' ? (
        <DeleteDialog
          title="Delete your account"
          body="This will permanently delete your account and all of your Jambu data, including preferences, activity history, routine patterns, interventions, pauses and snoozes."
          phrase="DELETE_ACCOUNT"
          action="Delete my account"
          onClose={() => setDialog({ kind: 'none' })}
          onConfirm={async (phrase) => {
            await deleteAccount(phrase);
            // Decision D107: the 202 is the confirmation. Forget the session
            // and the onboarding cache, then say plainly that it is done.
            // Nothing is polled — the token that would poll is already gone.
            await signOut();
            setSignedIn(false);
            setDialog({ kind: 'account-deleted' });
          }}
        />
      ) : null}
    </main>
  );
}

function Reminders({
  preferences,
  busy,
  onToggle,
  onEditTimezone,
  onEditWorkHours,
}: {
  preferences: PreferencesView | null;
  busy: boolean;
  onToggle: (type: InterventionType, next: boolean) => Promise<void>;
  onEditTimezone: () => void;
  onEditWorkHours: () => void;
}): ReactElement {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight">Reminder types</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        Choose which types of reminders you&apos;d like to receive.
      </p>

      <ul className="mt-4 flex flex-col gap-1">
        {INTERVENTION_ORDER.map((type) => {
          const meta = INTERVENTION_META[type];
          const checked = preferences?.[meta.preferenceKey] ?? false;
          return (
            <li key={type}>
              <Row
                icon={meta.icon}
                tone={meta.tone}
                label={meta.label}
                hint={meta.hint}
                testId={`type-${type}`}
                trailing={
                  <Switch
                    checked={checked}
                    label={meta.label}
                    testId={`toggle-${type}`}
                    onChange={(next) => {
                      if (!busy) void onToggle(type, next);
                    }}
                  />
                }
              />
            </li>
          );
        })}
      </ul>

      <h2 className="mt-7 text-base font-semibold tracking-tight">Your preferences</h2>
      <ul className="mt-2 flex flex-col gap-1">
        <li>
          <Row
            icon="🕘"
            tone="green"
            label="Work hours"
            onClick={onEditWorkHours}
            testId="row-work-hours"
            trailing={
              <span className="text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
                {preferences === null
                  ? '—'
                  : `${preferences.workStart} – ${preferences.workEnd}`}{' '}
                ›
              </span>
            }
          />
        </li>
        <li>
          <Row
            icon="🌐"
            tone="blue"
            label="Timezone"
            onClick={onEditTimezone}
            testId="row-timezone"
            trailing={
              <span className="text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
                {preferences?.timezone ?? '—'} ›
              </span>
            }
          />
        </li>
      </ul>
    </>
  );
}

function Pause({
  pause,
  workEnd,
  busy,
  onPause,
  onResume,
}: {
  pause: PauseState | null;
  workEnd: string;
  busy: boolean;
  onPause: (until: Date) => void;
  onResume: () => void;
}): ReactElement {
  if (pause?.paused === true) {
    return (
      <>
        <h1 className="text-lg font-semibold tracking-tight">Reminders paused</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
          Until {formatWhen(pause.pausedUntil)}
        </p>
        <div className="mt-4">
          <Callout>
            You won&apos;t see reminder cards during this time. Your activity will still
            be tracked.
          </Callout>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onResume}
          data-testid="resume-pause"
          className="jambu-button jambu-button-primary mt-4"
        >
          ▶ Resume reminders
        </button>
      </>
    );
  }

  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight">Pause reminders</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        Take a break from Jambu&apos;s reminders. Your activity will still be tracked to
        learn your patterns.
      </p>
      <ul className="mt-4 flex flex-col gap-1">
        {PAUSE_CHOICES.map((choice) => (
          <li key={choice.id}>
            <Row
              icon={choice.id === 'rest-of-day' ? '🌇' : '🕘'}
              tone={choice.id === 'rest-of-day' ? 'sun' : 'green'}
              label={choice.label}
              testId={`pause-${choice.id}`}
              hint={formatWhen(choice.resolve(new Date(), workEnd).toISOString())}
              onClick={() => {
                if (!busy) onPause(choice.resolve(new Date(), workEnd));
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function Snoozes({
  snoozes,
  busy,
  onClear,
}: {
  snoozes: SnoozeView[];
  busy: boolean;
  onClear: (type: InterventionType) => void;
}): ReactElement {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight">Snoozed reminders</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        These reminder types are snoozed temporarily. You can clear them here.
      </p>

      {snoozes.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
          Nothing is snoozed right now.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-1">
          {snoozes.map((snooze) => {
            const meta = INTERVENTION_META[snooze.type];
            return (
              <li key={snooze.type}>
                <Row
                  icon={meta.icon}
                  tone={meta.tone}
                  label={meta.label}
                  hint={`Until ${formatWhen(snooze.snoozedUntil)}`}
                  testId={`snooze-${snooze.type}`}
                  trailing={
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onClear(snooze.type)}
                      data-testid={`clear-${snooze.type}`}
                      className="jambu-button jambu-button-quiet px-3 py-1.5 text-xs"
                    >
                      Clear
                    </button>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        <Callout>
          Snoozes are created when you respond to a reminder. You can view and clear them
          here, but you can&apos;t create new snoozes.
        </Callout>
      </div>
    </>
  );
}

function Privacy({
  onExport,
  onDeleteActivity,
}: {
  onExport: () => void;
  onDeleteActivity: () => void;
}): ReactElement {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight">Privacy &amp; data</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        Jambu notices how long you work, never what you work on.
      </p>
      <ul className="mt-4 flex flex-col gap-1">
        <li>
          <Row
            icon="⬇"
            tone="warm"
            label="Export my data"
            hint="Download a copy in JSON format"
            onClick={onExport}
            testId="row-export"
            trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
          />
        </li>
        <li>
          <Row
            icon="🗑"
            danger
            label="Delete my activity"
            hint="Remove your activity history, keep your account"
            onClick={onDeleteActivity}
            testId="row-delete-activity"
            trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
          />
        </li>
      </ul>
    </>
  );
}

function Account({ onDeleteAccount }: { onDeleteAccount: () => void }): ReactElement {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight">Account</h1>
      <ul className="mt-4 flex flex-col gap-1">
        <li>
          <Row
            icon="🗑"
            danger
            label="Delete my account"
            hint="Remove your account and all data"
            onClick={onDeleteAccount}
            testId="row-delete-account"
            trailing={<span style={{ color: 'var(--jambu-ink-faint)' }}>›</span>}
          />
        </li>
      </ul>
    </>
  );
}

function ValueDialog({
  title,
  description,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  description: string;
  initial: string;
  onClose: () => void;
  onSave: (value: string) => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} testId="value-dialog">
      <p className="mb-3 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        {description}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        {title}
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          data-testid="value-input"
          className="rounded-lg border px-3 py-2"
          style={{ borderColor: 'var(--jambu-border-strong)' }}
        />
      </label>
      <button
        type="button"
        onClick={() => onSave(value)}
        className="jambu-button jambu-button-primary mt-4 w-full"
      >
        Save
      </button>
    </Modal>
  );
}

function WorkHoursDialog({
  start,
  end,
  onClose,
  onSave,
}: {
  start: string;
  end: string;
  onClose: () => void;
  onSave: (start: string, end: string) => void;
}): ReactElement {
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(end);
  return (
    <Modal title="Work hours" onClose={onClose} testId="work-hours-dialog">
      <p className="mb-3 text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        A rough guide only — Jambu learns your real rhythm from how you work.
      </p>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Start
          <input
            type="time"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            data-testid="work-start"
            className="rounded-lg border px-3 py-2"
            style={{ borderColor: 'var(--jambu-border-strong)' }}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          End
          <input
            type="time"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            data-testid="work-end"
            className="rounded-lg border px-3 py-2"
            style={{ borderColor: 'var(--jambu-border-strong)' }}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => onSave(from, to)}
        className="jambu-button jambu-button-primary mt-4 w-full"
      >
        Save
      </button>
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setFailed(null);
    try {
      const data = await fetchExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `jambu-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setFailed(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Export your data" onClose={onClose} testId="export-dialog">
      <p className="text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        Download a copy of your Jambu data in JSON format.
      </p>
      <ul
        className="my-3 flex flex-col gap-1 rounded-xl p-3 text-sm"
        style={{ background: 'var(--jambu-surface-muted)' }}
      >
        {[
          'Your profile and preferences',
          'Onboarding progress',
          'Activity history (no URLs or page content)',
          'Routine patterns',
          'Interventions and snoozes',
          'Pause history',
        ].map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden style={{ color: 'var(--jambu-green)' }}>
              ✓
            </span>
            {line}
          </li>
        ))}
      </ul>
      {failed === null ? null : (
        <div className="mb-3">
          <Callout tone="danger">{failed}</Callout>
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void download()}
        data-testid="download-export"
        className="jambu-button jambu-button-primary w-full"
      >
        {busy ? 'Preparing…' : '⬇ Download my data'}
      </button>
      <div className="mt-3">
        <Callout>
          Your export is limited to 10,000 records per collection. If a collection has
          more, it will be truncated and clearly marked in the file.
        </Callout>
      </div>
    </Modal>
  );
}

/**
 * The board's two delete screens (9 and 10).
 *
 * The action stays disabled until the phrase is typed exactly (D106) — the
 * same strictness the API enforces, so the button never promises something the
 * server will refuse.
 */
function DeleteDialog({
  title,
  body,
  phrase,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  phrase: string;
  action: string;
  onClose: () => void;
  onConfirm: (phrase: string) => Promise<void>;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const matches = typed === phrase;

  return (
    <Modal title={title} onClose={onClose} testId="delete-dialog">
      <p className="text-sm" style={{ color: 'var(--jambu-ink-muted)' }}>
        {body}
      </p>
      <div className="my-3">
        <Callout tone="danger">This action cannot be undone.</Callout>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span>
          Type <strong>{phrase}</strong> to confirm:
        </span>
        <input
          type="text"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          data-testid="confirm-input"
          className="rounded-lg border px-3 py-2 font-mono text-sm"
          style={{ borderColor: 'var(--jambu-border-strong)' }}
        />
      </label>
      {failed === null ? null : (
        <div className="mt-3">
          <Callout tone="danger">{failed}</Callout>
        </div>
      )}
      <button
        type="button"
        disabled={!matches || busy}
        data-testid="confirm-delete"
        onClick={() => {
          setBusy(true);
          setFailed(null);
          void onConfirm(typed)
            .catch((cause: unknown) => setFailed(describe(cause)))
            .finally(() => setBusy(false));
        }}
        className="jambu-button jambu-button-danger mt-4 w-full"
      >
        {busy ? 'Deleting…' : action}
      </button>
    </Modal>
  );
}
