/**
 * Pure user-state derivation (CLAUDE.md §12, decisions D6, D27, D30, D31).
 *
 * No database and no faked system clock: `now` is an input, so the whole
 * continuity / midnight / DST matrix is expressible as plain data.
 */
import { IDLE_BREAK_THRESHOLD_MINUTES } from '@jambu/shared-types';
import { describe, expect, it } from 'vitest';

import { deriveUserState, foldIntoRuns, type StoredSession } from './user-state.js';

const UTC = 'UTC';
const KOLKATA = 'Asia/Kolkata';

/** A session ending `endMinutesAgo` before `now`, lasting `lengthMinutes`. */
function sessionEnding(
  now: Date,
  endMinutesAgo: number,
  lengthMinutes: number,
  activeSeconds = lengthMinutes * 60,
): StoredSession {
  const endedAt = new Date(now.getTime() - endMinutesAgo * 60_000);
  return {
    startedAt: new Date(endedAt.getTime() - lengthMinutes * 60_000),
    endedAt,
    activeSeconds,
  };
}

function derive(now: Date, sessions: StoredSession[], overrides = {}) {
  return deriveUserState({ now, timeZone: UTC, sessions, paused: false, ...overrides });
}

const NOW = new Date('2026-09-21T12:00:00Z');

describe('the shared D6 constant is what drives continuity', () => {
  it('uses 10 minutes, from the shared contract', () => {
    expect(IDLE_BREAK_THRESHOLD_MINUTES).toBe(10);
  });
});

describe('empty / new user', () => {
  it('returns a valid state with no activity at all', () => {
    const state = derive(NOW, []);
    expect(state.continuousWorkMinutes).toBe(0);
    expect(state.totalWorkMinutesToday).toBe(0);
    expect(state.currentActivity).toBe('unknown');
    expect(state.paused).toBe(false);
    expect(state.lastBreakMinutesAgo).toBeUndefined();
    // Decision D30: the shape is always present.
    expect(state.lunchWindow?.source).toBe('default');
  });
});

describe('continuity gaps (decision D6)', () => {
  it('bridges a 9-minute gap into one run', () => {
    const sessions = [sessionEnding(NOW, 40, 20), sessionEnding(NOW, 1, 30)];
    // second starts 31 min before now; first ended 40 min before now => 9 min gap
    const runs = foldIntoRuns(sessions);
    expect(runs).toHaveLength(1);
    expect(derive(NOW, sessions).continuousWorkMinutes).toBe(50);
  });

  it('breaks on a gap of exactly 10 minutes', () => {
    // first ends 40 min ago, second starts 30 min ago => exactly 10.
    const sessions = [sessionEnding(NOW, 40, 20), sessionEnding(NOW, 5, 25)];
    expect(foldIntoRuns(sessions)).toHaveLength(2);
    // Only the current run counts.
    expect(derive(NOW, sessions).continuousWorkMinutes).toBe(25);
  });

  it('breaks on an 11-minute gap', () => {
    const sessions = [sessionEnding(NOW, 41, 20), sessionEnding(NOW, 5, 25)];
    expect(foldIntoRuns(sessions)).toHaveLength(2);
    expect(derive(NOW, sessions).continuousWorkMinutes).toBe(25);
  });

  it('chains several bridged sessions into one long run', () => {
    const sessions = [
      sessionEnding(NOW, 100, 30),
      sessionEnding(NOW, 95, 0),
      sessionEnding(NOW, 60, 30),
      sessionEnding(NOW, 2, 55),
    ];
    expect(foldIntoRuns(sessions)).toHaveLength(1);
    expect(derive(NOW, sessions).continuousWorkMinutes).toBe(115);
  });

  it('is order-independent', () => {
    const ordered = [sessionEnding(NOW, 40, 20), sessionEnding(NOW, 1, 30)];
    const shuffled = [...ordered].reverse();
    expect(derive(NOW, shuffled)).toEqual(derive(NOW, ordered));
  });
});

describe('the current run becoming inactive', () => {
  it('still counts a run whose last session ended 9 minutes ago', () => {
    expect(derive(NOW, [sessionEnding(NOW, 9, 45)]).continuousWorkMinutes).toBe(45);
  });

  it('zeroes the counter once the gap reaches 10 minutes', () => {
    expect(derive(NOW, [sessionEnding(NOW, 10, 45)]).continuousWorkMinutes).toBe(0);
  });

  it('zeroes the counter well after the user stopped', () => {
    expect(derive(NOW, [sessionEnding(NOW, 120, 45)]).continuousWorkMinutes).toBe(0);
  });
});

describe('lastBreakMinutesAgo', () => {
  it('measures from the end of the run before the current one', () => {
    const sessions = [sessionEnding(NOW, 60, 30), sessionEnding(NOW, 1, 20)];
    expect(derive(NOW, sessions).lastBreakMinutesAgo).toBe(60);
  });

  it('measures from the last run when no run is current', () => {
    expect(derive(NOW, [sessionEnding(NOW, 45, 30)]).lastBreakMinutesAgo).toBe(45);
  });

  it('is absent when there has only ever been one, still-current run', () => {
    expect(derive(NOW, [sessionEnding(NOW, 1, 30)]).lastBreakMinutesAgo).toBeUndefined();
  });
});

describe('currentActivity (decision D27)', () => {
  it('is unknown with no sessions — a fresh install, not an idle user', () => {
    expect(derive(NOW, []).currentActivity).toBe('unknown');
  });

  it('is active under two minutes', () => {
    expect(derive(NOW, [sessionEnding(NOW, 1, 10)]).currentActivity).toBe('active');
    expect(derive(NOW, [sessionEnding(NOW, 0, 10)]).currentActivity).toBe('active');
  });

  it('is idle at two minutes or more', () => {
    expect(derive(NOW, [sessionEnding(NOW, 2, 10)]).currentActivity).toBe('idle');
    expect(derive(NOW, [sessionEnding(NOW, 30, 10)]).currentActivity).toBe('idle');
  });

  it('uses the most recent session, not the most recent run', () => {
    const sessions = [sessionEnding(NOW, 200, 10), sessionEnding(NOW, 1, 10)];
    expect(derive(NOW, sessions).currentActivity).toBe('active');
  });
});

describe('totalWorkMinutesToday (CLAUDE.md §28, decision D31)', () => {
  it('counts the local day, not the UTC day', () => {
    // 2026-09-21T12:00Z is 17:30 Kolkata; the local day began 2026-09-20T18:30Z.
    const beforeLocalMidnight = {
      startedAt: new Date('2026-09-20T17:00:00Z'),
      endedAt: new Date('2026-09-20T17:30:00Z'),
      activeSeconds: 1800,
    };
    const afterLocalMidnight = {
      startedAt: new Date('2026-09-20T19:00:00Z'),
      endedAt: new Date('2026-09-20T19:30:00Z'),
      activeSeconds: 1800,
    };

    const state = deriveUserState({
      now: NOW,
      timeZone: KOLKATA,
      sessions: [beforeLocalMidnight, afterLocalMidnight],
      paused: false,
    });

    // Both are on the same UTC day; only the later one is in today's Kolkata day.
    expect(state.totalWorkMinutesToday).toBe(30);
  });

  it('counts both when the zone is UTC', () => {
    const state = deriveUserState({
      now: NOW,
      timeZone: UTC,
      sessions: [
        {
          startedAt: new Date('2026-09-21T01:00:00Z'),
          endedAt: new Date('2026-09-21T01:30:00Z'),
          activeSeconds: 1800,
        },
        {
          startedAt: new Date('2026-09-21T09:00:00Z'),
          endedAt: new Date('2026-09-21T09:30:00Z'),
          activeSeconds: 1800,
        },
      ],
      paused: false,
    });
    expect(state.totalWorkMinutesToday).toBe(60);
  });

  it('sums seconds first and converts once, so partial minutes do not vanish', () => {
    // Three sessions of 50s each: 150s -> 2 minutes. Flooring each first gives 0.
    const sessions = Array.from({ length: 3 }, (_, index) => ({
      startedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
      endedAt: new Date(NOW.getTime() - (index + 1) * 60_000 + 50_000),
      activeSeconds: 50,
    }));
    expect(derive(NOW, sessions).totalWorkMinutesToday).toBe(2);
  });
});

describe('lunchWindow (decision D30)', () => {
  it('returns the default window before anything is learned', () => {
    const state = deriveUserState({
      now: NOW,
      timeZone: KOLKATA,
      sessions: [],
      paused: false,
    });

    expect(state.lunchWindow).toEqual({
      // 12:30 and 14:30 local Kolkata on 2026-09-21.
      start: '2026-09-21T07:00:00.000Z',
      end: '2026-09-21T09:00:00.000Z',
      confidence: 0,
      source: 'default',
    });
  });

  it('prefers a learned window and marks it as such', () => {
    const state = deriveUserState({
      now: NOW,
      timeZone: KOLKATA,
      sessions: [],
      paused: false,
      learnedLunchWindow: { start: '13:25', end: '13:45', confidence: 0.78 },
    });

    expect(state.lunchWindow).toEqual({
      start: '2026-09-21T07:55:00.000Z',
      end: '2026-09-21T08:15:00.000Z',
      confidence: 0.78,
      source: 'learned',
    });
  });

  it('never reports the default as learned, whatever its confidence', () => {
    const state = derive(NOW, []);
    expect(state.lunchWindow?.source).toBe('default');
    expect(state.lunchWindow?.confidence).toBe(0);
  });
});

describe('pause state', () => {
  it('reports paused when the user has paused Jambu', () => {
    expect(derive(NOW, [], { paused: true }).paused).toBe(true);
    expect(derive(NOW, [], { paused: false }).paused).toBe(false);
  });
});

describe('determinism and purity', () => {
  it('returns identical output for identical input', () => {
    const sessions = [sessionEnding(NOW, 40, 20), sessionEnding(NOW, 1, 30)];
    const first = derive(NOW, sessions);
    const second = derive(NOW, sessions);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('depends on the supplied now, not on the system clock', () => {
    const sessions = [sessionEnding(NOW, 1, 30)];
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(derive(NOW, sessions).currentActivity).toBe('active');
    expect(derive(later, sessions).currentActivity).toBe('idle');
  });

  it('does not mutate the sessions it is given', () => {
    const sessions = [sessionEnding(NOW, 40, 20), sessionEnding(NOW, 1, 30)];
    const snapshot = JSON.stringify(sessions);
    derive(NOW, sessions);
    expect(JSON.stringify(sessions)).toBe(snapshot);
  });

  it('carries no domain or URL anywhere in the state (CLAUDE.md §9)', () => {
    const state = derive(NOW, [sessionEnding(NOW, 1, 30)]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/domain|url|http/i);
  });
});
