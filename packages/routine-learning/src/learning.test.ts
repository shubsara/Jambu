/**
 * Routine learning (CLAUDE.md §16, decisions D77-D84).
 *
 * Every case is plain data: observations are local days and local minutes, so
 * nothing here needs a clock, a timezone or a database.
 */
import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_BY_TIER,
  MIN_RUN_MINUTES_FOR_BREAK_LEARNING,
  TIER_THRESHOLDS,
  confidenceFor,
  groupByLocalDay,
  hasEnoughObservations,
  learnBreakInterval,
  learnLunchWindow,
  learnRoutines,
  learnWorkHours,
  lunchObservations,
  median,
  tierFor,
  toTimeOfDay,
  type LocalRun,
} from './index.js';

/** `HH:mm` to minutes from local midnight. */
function at(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** A day of work split by a lunch gap starting at `lunchAt`. */
function dayWithLunch(localDay: string, lunchAt: string, gapMinutes = 45): LocalRun[] {
  return [
    { localDay, startMinute: at('09:00'), endMinute: at(lunchAt) },
    { localDay, startMinute: at(lunchAt) + gapMinutes, endMinute: at('18:00') },
  ];
}

describe('median (CLAUDE.md §16 — robust statistics)', () => {
  it('returns the middle value for an odd count', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns null for nothing', () => {
    expect(median([])).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('confidence tiers (CLAUDE.md §16, decision D81)', () => {
  it('matches the §16 boundaries', () => {
    expect(TIER_THRESHOLDS).toEqual({ low: 3, medium: 8, high: 15 });
  });

  it('classifies each band', () => {
    expect(tierFor(0)).toBe('insufficient');
    expect(tierFor(2)).toBe('insufficient');
    expect(tierFor(3)).toBe('low');
    expect(tierFor(7)).toBe('low');
    expect(tierFor(8)).toBe('medium');
    expect(tierFor(14)).toBe('medium');
    expect(tierFor(15)).toBe('high');
    expect(tierFor(100)).toBe('high');
  });

  it('gives insufficient evidence exactly zero confidence', () => {
    // Decision D8 depends on this: a zero-confidence pattern can never earn
    // the Care Engine's +20 historical bonus, so a default cannot pass as
    // learned.
    expect(confidenceFor(2)).toBe(0);
    expect(CONFIDENCE_BY_TIER.insufficient).toBe(0);
  });

  it('increases with evidence and never exceeds one', () => {
    const values = [0, 3, 8, 15].map(confidenceFor);
    expect(values).toEqual([0, 0.4, 0.65, 0.85]);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('personalizes only at three observations or more', () => {
    expect(hasEnoughObservations(2)).toBe(false);
    expect(hasEnoughObservations(3)).toBe(true);
  });
});

describe('the §16 worked example', () => {
  it('reproduces 13:20/13:42/13:35/13:29/13:38 as roughly 13:25-13:45', () => {
    const runs = [
      ...dayWithLunch('2026-09-14', '13:20'),
      ...dayWithLunch('2026-09-15', '13:42'),
      ...dayWithLunch('2026-09-16', '13:35'),
      ...dayWithLunch('2026-09-17', '13:29'),
      ...dayWithLunch('2026-09-18', '13:38'),
    ];

    const learned = learnLunchWindow(runs);

    expect(learned).not.toBeNull();
    expect(toTimeOfDay(learned?.startMinute ?? 0)).toBe('13:25');
    expect(toTimeOfDay(learned?.endMinute ?? 0)).toBe('13:45');
    expect(learned?.sampleCount).toBe(5);
    // Five observations is the low tier.
    expect(learned?.confidence).toBe(0.4);
  });
});

describe('lunch observations (decision D78 — the midday gap)', () => {
  it('takes at most one observation per day', () => {
    // A fragmented afternoon must not inflate confidence.
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('12:30') },
      { localDay: '2026-09-14', startMinute: at('13:15'), endMinute: at('13:30') },
      { localDay: '2026-09-14', startMinute: at('14:00'), endMinute: at('18:00') },
    ];

    expect(lunchObservations(runs)).toHaveLength(1);
  });

  it('prefers the longest midday gap as the likeliest meal', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('11:30') },
      // 20-minute gap
      { localDay: '2026-09-14', startMinute: at('11:50'), endMinute: at('13:00') },
      // 60-minute gap — lunch
      { localDay: '2026-09-14', startMinute: at('14:00'), endMinute: at('18:00') },
    ];

    expect(lunchObservations(runs)).toEqual([at('13:00')]);
  });

  it('ignores gaps outside the midday search range', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('08:00'), endMinute: at('09:00') },
      // A 09:00 gap is arriving late, not lunch.
      { localDay: '2026-09-14', startMinute: at('10:00'), endMinute: at('16:00') },
      // A 16:00 gap is going home.
      { localDay: '2026-09-14', startMinute: at('17:30'), endMinute: at('18:00') },
    ];

    expect(lunchObservations(runs)).toEqual([]);
  });

  it('ignores a gap too short to be a meal', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('13:00') },
      // Five minutes: a coffee refill.
      { localDay: '2026-09-14', startMinute: at('13:05'), endMinute: at('18:00') },
    ];

    expect(lunchObservations(runs)).toEqual([]);
  });

  it('ignores a day with no break at all', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('18:00') },
    ];
    expect(lunchObservations(runs)).toEqual([]);
  });
});

describe('insufficient observations (CLAUDE.md §16)', () => {
  it('learns nothing from two days, however consistent', () => {
    const runs = [
      ...dayWithLunch('2026-09-14', '13:00'),
      ...dayWithLunch('2026-09-15', '13:00'),
    ];

    // Two identical days are still not evidence.
    expect(learnLunchWindow(runs)).toBeNull();
    expect(learnWorkHours(runs)).toBeNull();
  });

  it('learns from exactly three', () => {
    const runs = [
      ...dayWithLunch('2026-09-14', '13:00'),
      ...dayWithLunch('2026-09-15', '13:00'),
      ...dayWithLunch('2026-09-16', '13:00'),
    ];

    expect(learnLunchWindow(runs)).not.toBeNull();
    expect(learnLunchWindow(runs)?.sampleCount).toBe(3);
  });

  it('learns nothing from no observations at all', () => {
    expect(learnRoutines([])).toEqual({
      lunch: null,
      workStart: null,
      workEnd: null,
      breakInterval: null,
    });
  });
});

describe('outlier resistance (decision D82, representative data)', () => {
  it('moves the window under five minutes when one day is wildly late', () => {
    const consistent = [
      ...dayWithLunch('2026-09-14', '13:00'),
      ...dayWithLunch('2026-09-15', '13:05'),
      ...dayWithLunch('2026-09-16', '12:58'),
      ...dayWithLunch('2026-09-17', '13:02'),
      ...dayWithLunch('2026-09-18', '13:04'),
    ];
    const withOutlier = [...consistent, ...dayWithLunch('2026-09-19', '14:55')];

    const before = learnLunchWindow(consistent);
    const after = learnLunchWindow(withOutlier);

    const shift = Math.abs((after?.startMinute ?? 0) - (before?.startMinute ?? 0));
    expect(shift).toBeLessThan(5);
  });

  it('a mean would have moved further — which is why §16 asks for a median', () => {
    const observations = [780, 785, 778, 782, 784];
    const withOutlier = [...observations, 895];

    const medianShift = Math.abs(
      (median(withOutlier) as number) - (median(observations) as number),
    );
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const meanShift = Math.abs(mean(withOutlier) - mean(observations));

    expect(medianShift).toBeLessThan(5);
    expect(meanShift).toBeGreaterThan(medianShift);
  });

  it('still follows a genuine change in routine', () => {
    // Robustness must not mean deafness: a sustained shift should be learned.
    const shifted = [
      ...dayWithLunch('2026-09-14', '12:00'),
      ...dayWithLunch('2026-09-15', '12:00'),
      ...dayWithLunch('2026-09-16', '12:00'),
      ...dayWithLunch('2026-09-17', '14:00'),
      ...dayWithLunch('2026-09-18', '14:00'),
      ...dayWithLunch('2026-09-19', '14:00'),
      ...dayWithLunch('2026-09-20', '14:00'),
    ];

    expect(toTimeOfDay(learnLunchWindow(shifted)?.startMinute ?? 0)).toBe('13:50');
  });
});

describe('work hours (decision D84)', () => {
  const runs = [
    ...dayWithLunch('2026-09-14', '13:00'),
    ...dayWithLunch('2026-09-15', '13:00'),
    ...dayWithLunch('2026-09-16', '13:00'),
  ];

  it('takes the median first start and last end', () => {
    const learned = learnWorkHours(runs);

    expect(toTimeOfDay(learned?.start.startMinute ?? 0)).toBe('09:00');
    expect(toTimeOfDay(learned?.end.endMinute ?? 0)).toBe('18:00');
    expect(learned?.start.sampleCount).toBe(3);
  });

  it('is not dragged across by one late night', () => {
    const withLateNight: LocalRun[] = [
      ...runs,
      { localDay: '2026-09-17', startMinute: at('09:00'), endMinute: at('23:30') },
      { localDay: '2026-09-18', startMinute: at('09:00'), endMinute: at('18:00') },
    ];

    expect(toTimeOfDay(learnWorkHours(withLateNight)?.end.endMinute ?? 0)).toBe('18:00');
  });

  it('uses the last end of the day, not the first', () => {
    const fragmented: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('12:00') },
      { localDay: '2026-09-14', startMinute: at('13:00'), endMinute: at('19:00') },
      { localDay: '2026-09-15', startMinute: at('09:00'), endMinute: at('19:00') },
      { localDay: '2026-09-16', startMinute: at('09:00'), endMinute: at('19:00') },
    ];

    expect(toTimeOfDay(learnWorkHours(fragmented)?.end.endMinute ?? 0)).toBe('19:00');
  });
});

describe('break interval (decision D77 — a duration, not a span)', () => {
  it('learns the typical run length in minutes', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('10:30') },
      { localDay: '2026-09-15', startMinute: at('09:00'), endMinute: at('10:30') },
      { localDay: '2026-09-16', startMinute: at('09:00'), endMinute: at('10:30') },
    ];

    const learned = learnBreakInterval(runs);
    expect(learned?.intervalMinutes).toBe(90);
    expect(learned?.sampleCount).toBe(3);
  });

  it('expresses intervals beyond a day, which the old span encoding could not', () => {
    const marathon: LocalRun[] = Array.from({ length: 3 }, (_, index) => ({
      localDay: `2026-09-1${index + 4}`,
      startMinute: 0,
      endMinute: 1500, // 25 hours
    }));

    expect(learnBreakInterval(marathon)?.intervalMinutes).toBe(1500);
  });

  it('ignores runs too short to be work', () => {
    const glances: LocalRun[] = Array.from({ length: 5 }, (_, index) => ({
      localDay: `2026-09-1${index + 4}`,
      startMinute: at('09:00'),
      endMinute: at('09:00') + MIN_RUN_MINUTES_FOR_BREAK_LEARNING - 1,
    }));

    expect(learnBreakInterval(glances)).toBeNull();
  });

  it('learns nothing below the observation threshold', () => {
    const runs: LocalRun[] = [
      { localDay: '2026-09-14', startMinute: at('09:00'), endMinute: at('11:00') },
      { localDay: '2026-09-15', startMinute: at('09:00'), endMinute: at('11:00') },
    ];
    expect(learnBreakInterval(runs)).toBeNull();
  });
});

describe('purity and determinism', () => {
  const runs = [
    ...dayWithLunch('2026-09-14', '13:00'),
    ...dayWithLunch('2026-09-15', '13:10'),
    ...dayWithLunch('2026-09-16', '12:55'),
  ];

  it('returns the same routines for the same observations, every time', () => {
    const first = learnRoutines(runs);
    for (let run = 0; run < 25; run += 1) {
      expect(learnRoutines(runs)).toEqual(first);
    }
  });

  it('is order-independent', () => {
    expect(learnRoutines([...runs].reverse())).toEqual(learnRoutines(runs));
  });

  it('does not mutate the observations it is given', () => {
    const snapshot = JSON.stringify(runs);
    learnRoutines(runs);
    expect(JSON.stringify(runs)).toBe(snapshot);
  });

  it('accepts no domain or identifying field (CLAUDE.md §9)', () => {
    // The observation type carries only a local day and two minute offsets.
    const observation = runs[0] as unknown as Record<string, unknown>;
    expect(Object.keys(observation).sort()).toEqual([
      'endMinute',
      'localDay',
      'startMinute',
    ]);
  });

  it('groups by local day without losing runs', () => {
    const grouped = groupByLocalDay(runs);
    expect(grouped.size).toBe(3);
    expect([...grouped.values()].flat()).toHaveLength(runs.length);
  });
});

describe('toTimeOfDay', () => {
  it('renders minutes as HH:mm', () => {
    expect(toTimeOfDay(0)).toBe('00:00');
    expect(toTimeOfDay(at('13:35'))).toBe('13:35');
    expect(toTimeOfDay(at('23:59'))).toBe('23:59');
  });

  it('clamps rather than wrapping past the end of the day', () => {
    expect(toTimeOfDay(-30)).toBe('00:00');
    expect(toTimeOfDay(24 * 60 + 30)).toBe('23:59');
  });
});
