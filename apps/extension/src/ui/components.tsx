/**
 * The pieces the P13 board is built from.
 *
 * Every screen on the reference board is the same handful of shapes: a row
 * with a pastel icon tile, a pill switch, a rounded card, a centred dialog,
 * a soft callout. They live here once so the popup and the options page stay
 * identical rather than merely similar.
 *
 * Presentation only — nothing here calls an API or decides anything.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

export type TileTone = 'green' | 'blue' | 'warm' | 'sun' | 'danger';

const TILE_BACKGROUND: Record<TileTone, string> = {
  green: 'var(--jambu-tile-green)',
  blue: 'var(--jambu-tile-blue)',
  warm: 'var(--jambu-tile-warm)',
  sun: 'var(--jambu-tile-sun)',
  danger: 'var(--jambu-danger-soft)',
};

export function Tile({
  tone,
  children,
}: {
  tone: TileTone;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      className="jambu-tile"
      style={{ background: TILE_BACKGROUND[tone] }}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** A tappable row — the board's menu and settings entries. */
export function Row({
  icon,
  tone = 'green',
  label,
  hint,
  trailing,
  onClick,
  danger = false,
  testId,
}: {
  icon: ReactNode;
  tone?: TileTone;
  label: string;
  hint?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  testId?: string;
}): ReactElement {
  const content = (
    <>
      <Tile tone={danger ? 'danger' : tone}>{icon}</Tile>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm font-medium"
          style={{ color: danger ? 'var(--jambu-danger)' : 'var(--jambu-ink)' }}
        >
          {label}
        </span>
        {hint === undefined ? null : (
          <span
            className="block truncate text-xs"
            style={{ color: 'var(--jambu-ink-muted)' }}
          >
            {hint}
          </span>
        )}
      </span>
      {trailing}
    </>
  );

  if (onClick === undefined) {
    return (
      <div className="jambu-row" data-testid={testId}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" className="jambu-row" onClick={onClick} data-testid={testId}>
      {content}
    </button>
  );
}

/**
 * The board's pill switch.
 *
 * A real checkbox underneath, visually replaced: screen readers and keyboards
 * get the control they expect, and the look still matches the mockup.
 */
export function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
}): ReactElement {
  return (
    <label className="relative inline-flex cursor-pointer items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="jambu-switch" data-on={checked} />
    </label>
  );
}

export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'danger';
  children: ReactNode;
}): ReactElement {
  return (
    <p className={`jambu-callout${tone === 'danger' ? ' jambu-callout-danger' : ''}`}>
      <span aria-hidden>{tone === 'danger' ? '⚠️' : 'ℹ️'}</span>
      <span>{children}</span>
    </p>
  );
}

/**
 * A centred dialog — the board's pause, snooze, export and delete screens.
 *
 * Unlike the Care Card (D71, which must never steal focus), a dialog the user
 * deliberately opened *should* take focus: they asked for it, and that is what
 * makes Escape and Tab behave. Escape always closes.
 */
export function Modal({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}): ReactElement {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: 'rgb(31 36 33 / 38%)' }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className="jambu-card jambu-raised w-full max-w-sm p-5 outline-none"
      >
        <div className="mb-3 flex items-start gap-3">
          <h2 className="flex-1 text-base font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-lg leading-none"
            style={{ color: 'var(--jambu-ink-faint)' }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Formats an instant the way the board shows pause and snooze ends. */
export function formatWhen(iso: string | null): string {
  if (iso === null) {
    return 'until you resume';
  }
  const when = new Date(iso);
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const isToday = when.toDateString() === new Date().toDateString();
  return isToday ? `today, ${time}` : `${when.toLocaleDateString()}, ${time}`;
}
