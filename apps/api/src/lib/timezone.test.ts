/**
 * Timezone arithmetic (CLAUDE.md §28, decision D28).
 *
 * These cases exist because "it works in UTC" is the bug: lunch, work hours
 * and the daily total are all local-time concepts computed over UTC-stored
 * data.
 */
import { describe, expect, it } from 'vitest';

import {
  isSameLocalDay,
  isValidTimeZone,
  localTimeOnDay,
  localTimeToUtc,
  resolveTimeZone,
  startOfLocalDay,
  wallClockAt,
} from './timezone.js';

describe('zone validation', () => {
  it('accepts real IANA zones', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Eucla']) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it('rejects nonsense', () => {
    for (const zone of ['', '   ', 'Mars/Olympus', 'Not A Zone']) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });

  it('falls back to UTC rather than failing the request', () => {
    expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(resolveTimeZone('Mars/Olympus')).toBe('UTC');
    expect(resolveTimeZone(null)).toBe('UTC');
    expect(resolveTimeZone(undefined)).toBe('UTC');
  });
});

describe('Asia/Kolkata — a half-hour offset', () => {
  const KOLKATA = 'Asia/Kolkata';

  it('reads the wall clock with the +05:30 offset applied', () => {
    // 2026-09-21T09:40:00Z is 15:10 in Kolkata.
    const wall = wallClockAt(new Date('2026-09-21T09:40:00Z'), KOLKATA);
    expect(wall.hour).toBe(15);
    expect(wall.minute).toBe(10);
    expect(wall.day).toBe(21);
  });

  it('starts the local day at 18:30Z the previous day', () => {
    const start = startOfLocalDay(new Date('2026-09-21T09:40:00Z'), KOLKATA);
    expect(start.toISOString()).toBe('2026-09-20T18:30:00.000Z');
  });

  it('resolves a local HH:mm onto the correct instant', () => {
    // 12:30 local on 2026-09-21 is 07:00Z.
    const noon = localTimeOnDay(new Date('2026-09-21T09:40:00Z'), KOLKATA, '12:30');
    expect(noon.toISOString()).toBe('2026-09-21T07:00:00.000Z');
  });
});

describe('UTC midnight is not local midnight', () => {
  const KOLKATA = 'Asia/Kolkata';

  it('treats 20:00Z as already tomorrow in Kolkata', () => {
    const instant = new Date('2026-09-21T20:00:00Z'); // 2026-09-22 01:30 local
    expect(wallClockAt(instant, KOLKATA).day).toBe(22);
    expect(startOfLocalDay(instant, KOLKATA).toISOString()).toBe(
      '2026-09-21T18:30:00.000Z',
    );
  });

  it('keeps two instants either side of UTC midnight on the same local day', () => {
    // 23:00Z and 01:00Z are 04:30 and 06:30 local — the same Kolkata day.
    const before = new Date('2026-09-21T23:00:00Z');
    const after = new Date('2026-09-22T01:00:00Z');
    expect(isSameLocalDay(before, after, KOLKATA)).toBe(true);
    // In UTC they are different days.
    expect(isSameLocalDay(before, after, 'UTC')).toBe(false);
  });

  it('splits a local day that UTC would call one day', () => {
    // 18:00Z and 19:00Z on the same UTC day straddle Kolkata midnight.
    const before = new Date('2026-09-21T18:00:00Z'); // 23:30 local, 21st
    const after = new Date('2026-09-21T19:00:00Z'); // 00:30 local, 22nd
    expect(isSameLocalDay(before, after, 'UTC')).toBe(true);
    expect(isSameLocalDay(before, after, KOLKATA)).toBe(false);
  });
});

describe('DST transitions', () => {
  const NEW_YORK = 'America/New_York';

  it('resolves local times either side of the spring-forward boundary', () => {
    // 2026-03-08: US clocks jump 02:00 -> 03:00 local.
    const beforeJump = localTimeToUtc(NEW_YORK, 2026, 3, 8, 1, 30);
    expect(beforeJump.toISOString()).toBe('2026-03-08T06:30:00.000Z'); // UTC-5

    const afterJump = localTimeToUtc(NEW_YORK, 2026, 3, 8, 3, 30);
    expect(afterJump.toISOString()).toBe('2026-03-08T07:30:00.000Z'); // UTC-4
  });

  it('starts a spring-forward day at the pre-transition offset', () => {
    const start = startOfLocalDay(new Date('2026-03-08T12:00:00Z'), NEW_YORK);
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('handles the autumn fall-back day', () => {
    // 2026-11-01: clocks go back; the local day is 25 hours long.
    const start = startOfLocalDay(new Date('2026-11-01T12:00:00Z'), NEW_YORK);
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // still UTC-4

    const nextStart = startOfLocalDay(new Date('2026-11-02T12:00:00Z'), NEW_YORK);
    expect(nextStart.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // now UTC-5
    expect(nextStart.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });

  it('keeps a zone without DST stable across the year', () => {
    const march = localTimeOnDay(
      new Date('2026-03-08T12:00:00Z'),
      'Asia/Kolkata',
      '12:30',
    );
    const july = localTimeOnDay(
      new Date('2026-07-08T12:00:00Z'),
      'Asia/Kolkata',
      '12:30',
    );
    expect(march.toISOString().slice(11)).toBe(july.toISOString().slice(11));
  });
});

describe('UTC behaves as the identity case', () => {
  it('starts the day at midnight', () => {
    expect(startOfLocalDay(new Date('2026-09-21T09:40:00Z'), 'UTC').toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
});
