/**
 * Timezone arithmetic (CLAUDE.md §28, decision D28).
 *
 * Built on the runtime's own IANA database via `Intl` — no dependency. That
 * matters for correctness, not just weight: DST transitions and half-hour
 * offsets such as `Asia/Kolkata` fall out of the zone database rather than
 * from offset arithmetic we would have to maintain ourselves.
 *
 * Everything here is pure. No function reads the clock; the caller supplies
 * the instant.
 */
import type { IanaTimeZone } from '@jambu/shared-types';

/** Whether the runtime recognises this IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fall back to UTC for an unusable zone.
 *
 * A stored timezone should always be valid — registration validates it — but a
 * bad value must degrade to a defensible default rather than fail the request
 * and leave the user with no state at all.
 */
export function resolveTimeZone(timeZone: string | null | undefined): IanaTimeZone {
  return timeZone !== null && timeZone !== undefined && isValidTimeZone(timeZone)
    ? timeZone
    : 'UTC';
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock reading a zone shows at a given instant. */
export function wallClockAt(instant: Date, timeZone: IanaTimeZone): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetMsAt(instant: Date, timeZone: IanaTimeZone): number {
  const wall = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - instant.getTime();
}

/**
 * Convert a local wall-clock time in a zone to the UTC instant it denotes.
 *
 * Resolved in two passes. The first guess uses the offset in force at the
 * naive UTC interpretation; near a DST boundary that offset can be the wrong
 * side of the transition, so the result is recomputed using the offset at the
 * candidate instant.
 */
export function localTimeToUtc(
  timeZone: IanaTimeZone,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const firstPass = naive - offsetMsAt(new Date(naive), timeZone);
  const secondPass = naive - offsetMsAt(new Date(firstPass), timeZone);

  return new Date(secondPass);
}

/** The instant at which the user's local day containing `instant` began. */
export function startOfLocalDay(instant: Date, timeZone: IanaTimeZone): Date {
  const wall = wallClockAt(instant, timeZone);
  return localTimeToUtc(timeZone, wall.year, wall.month, wall.day, 0, 0);
}

/**
 * Resolve an `HH:mm` local time onto the local day containing `instant`.
 *
 * Used for the default lunch window, which CLAUDE.md and decision D8 express
 * in the user's local wall-clock terms.
 */
export function localTimeOnDay(
  instant: Date,
  timeZone: IanaTimeZone,
  timeOfDay: string,
): Date {
  const [hourText, minuteText] = timeOfDay.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const wall = wallClockAt(instant, timeZone);

  return localTimeToUtc(timeZone, wall.year, wall.month, wall.day, hour, minute);
}

/** Whether two instants fall on the same local calendar day in a zone. */
export function isSameLocalDay(a: Date, b: Date, timeZone: IanaTimeZone): boolean {
  const left = wallClockAt(a, timeZone);
  const right = wallClockAt(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}
