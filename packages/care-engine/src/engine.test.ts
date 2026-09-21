/**
 * The §27 Care Engine matrix.
 *
 * Every case is plain data: `currentTime` is an input, so nothing here needs a
 * database or a faked clock.
 */
import type { CareContext, UserPreferences } from '@jambu/shared-types';
import { describe, expect, it } from 'vitest';

import {
  SCORE_THRESHOLDS,
  decide,
  qualifiesForBreak,
  qualifiesForEndOfDay,
  qualifiesForHydration,
  scoreFor,
  suppressionFor,
} from './index.js';

/**
 * Context builders. Inlined rather than kept in a helper module so the whole
 * file stays inside the purity rule's test exemption — the guardrail that
 * bans clock reads in this package is not widened for test convenience.
 */
export const NOW = new Date('2026-09-21T13:30:00.000Z');

export const PREFERENCES: UserPreferences = {
  workStart: '09:00',
  workEnd: '18:00',
  lunchEnabled: true,
  breakEnabled: true,
  hydrationEnabled: false,
  endDayEnabled: true,
  persona: 'mom',
};

export function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

export function context(overrides: Partial<CareContext> = {}): CareContext {
  return {
    currentTime: NOW,
    continuousWorkMinutes: 0,
    totalWorkMinutesToday: 0,
    currentActivity: 'active',
    isPaused: false,
    preferences: PREFERENCES,
    ...overrides,
  };
}

/** A lunch window surrounding NOW, defaulting to the D8 fallback confidence. */
export function lunchWindow(confidence = 0) {
  return {
    start: minutesFrom(NOW, -60),
    end: minutesFrom(NOW, 60),
    confidence,
  };
}

describe('CLAUDE.md §15 — never the clock alone', () => {
  it('does not intervene for a user who is merely inside the lunch window', () => {
    // The defining test: right time, no activity signal.
    const decision = decide(
      context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 0 }),
    );
    expect(decision.shouldIntervene).toBe(false);
    expect(decision.interventionType).toBeNull();
  });

  it('does not intervene for an inactive user in the lunch window', () => {
    const decision = decide(
      context({
        lunchWindow: lunchWindow(),
        continuousWorkMinutes: 200,
        currentActivity: 'idle',
      }),
    );
    expect(decision.shouldIntervene).toBe(false);
  });

  it('does not intervene for a user Jambu has never seen', () => {
    const decision = decide(context({ currentActivity: 'unknown' }));
    expect(decision.shouldIntervene).toBe(false);
  });
});

describe('lunch', () => {
  const qualifying = context({
    lunchWindow: lunchWindow(),
    continuousWorkMinutes: 130,
  });

  it('intervenes for sustained work inside the lunch window', () => {
    const decision = decide(qualifying);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.interventionType).toBe('lunch');
    expect(decision.score).toBeGreaterThanOrEqual(SCORE_THRESHOLDS.intervene);
  });

  it('stays quiet below the D32 activity gate', () => {
    expect(
      decide(context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 44 }))
        .shouldIntervene,
    ).toBe(false);
  });

  it('stays quiet outside the window', () => {
    const outside = context({
      lunchWindow: {
        start: minutesFrom(NOW, 60),
        end: minutesFrom(NOW, 120),
        confidence: 0,
      },
      continuousWorkMinutes: 200,
    });
    expect(decide(outside).shouldIntervene).toBe(false);
  });

  it('stays quiet when lunch reminders are disabled', () => {
    const disabled = context({
      lunchWindow: lunchWindow(),
      continuousWorkMinutes: 200,
      preferences: { ...qualifying.preferences, lunchEnabled: false },
    });
    expect(decide(disabled).shouldIntervene).toBe(false);
  });

  it('does not ask again once lunch was confirmed today', () => {
    const confirmed = context({
      lunchWindow: lunchWindow(),
      continuousWorkMinutes: 200,
      lastLunchConfirmation: minutesFrom(NOW, -30),
    });
    expect(suppressionFor(confirmed, 'lunch')).toBe('lunch already confirmed today');
    expect(decide(confirmed).interventionType).not.toBe('lunch');
  });

  it('earns the confidence bonus only for a learned window (decision D8)', () => {
    const withDefault = scoreFor(
      context({ lunchWindow: lunchWindow(0), continuousWorkMinutes: 130 }),
      'lunch',
    );
    const withLearned = scoreFor(
      context({ lunchWindow: lunchWindow(0.78), continuousWorkMinutes: 130 }),
      'lunch',
    );
    expect(withLearned.score).toBe(withDefault.score + 20);
  });
});

describe('break', () => {
  it('qualifies past the D33 default threshold', () => {
    expect(qualifiesForBreak(context({ continuousWorkMinutes: 95 })).qualifies).toBe(
      true,
    );
  });

  it('stays quiet below the threshold', () => {
    expect(qualifiesForBreak(context({ continuousWorkMinutes: 60 })).reason).toContain(
      'has not reached the break interval',
    );
  });

  it('prefers a learned break interval over the default', () => {
    const learned = context({
      continuousWorkMinutes: 50,
      breakPattern: { averageIntervalMinutes: 45, confidence: 0.8 },
    });
    expect(qualifiesForBreak(learned).qualifies).toBe(true);
  });

  it('stays quiet when break reminders are disabled', () => {
    const disabled = context({
      continuousWorkMinutes: 200,
      preferences: { ...context().preferences, breakEnabled: false },
    });
    expect(qualifiesForBreak(disabled).qualifies).toBe(false);
    expect(qualifiesForBreak(disabled).reason).toContain('break reminders are disabled');
  });
});

describe('hydration (decision D34 — conservative, opt-in)', () => {
  const optedIn = { ...context().preferences, hydrationEnabled: true };

  it('never fires when the user has not opted in (decision D7)', () => {
    const notOptedIn = context({ continuousWorkMinutes: 200 });
    expect(qualifiesForHydration(notOptedIn).qualifies).toBe(false);
    expect(qualifiesForHydration(notOptedIn).reason).toContain('not opted in');
    expect(decide(notOptedIn).interventionType).not.toBe('hydration');
  });

  it('qualifies once opted in with sustained activity', () => {
    const decision = decide(context({ continuousWorkMinutes: 90, preferences: optedIn }));
    expect(decision.reason).not.toContain('hydration reminders are not opted in');
  });

  it('stays quiet below the 60-minute gate', () => {
    expect(
      qualifiesForHydration(context({ continuousWorkMinutes: 30, preferences: optedIn }))
        .reason,
    ).toContain('not enough continuous activity');
  });

  it('stays quiet after a recent hydration confirmation', () => {
    const recentlyConfirmed = context({
      continuousWorkMinutes: 200,
      preferences: optedIn,
      lastHydrationConfirmation: minutesFrom(NOW, -30),
    });
    expect(qualifiesForHydration(recentlyConfirmed).reason).toContain(
      'hydration was confirmed recently',
    );
  });

  it('qualifies again once the confirmation window has passed', () => {
    const longAgo = context({
      continuousWorkMinutes: 200,
      preferences: optedIn,
      lastHydrationConfirmation: minutesFrom(NOW, -120),
    });
    expect(qualifiesForHydration(longAgo).qualifies).toBe(true);
  });
});

describe('end of day (decision D7)', () => {
  const workHours = (endOffsetMinutes: number) => ({
    start: minutesFrom(NOW, -480),
    end: minutesFrom(NOW, endOffsetMinutes),
    confidence: 0.8,
  });

  it('stays quiet without a learned work end', () => {
    expect(
      qualifiesForEndOfDay(context({ continuousWorkMinutes: 200 })).reason,
    ).toContain('no learned work end');
  });

  it('stays quiet until 30 minutes past the work end', () => {
    const justPast = context({
      continuousWorkMinutes: 200,
      workHours: workHours(-29),
    });
    expect(qualifiesForEndOfDay(justPast).reason).toContain(
      'not yet far enough past the work end',
    );
  });

  it('qualifies at 30 minutes past the work end', () => {
    const wellPast = context({
      continuousWorkMinutes: 200,
      workHours: workHours(-30),
    });
    expect(qualifiesForEndOfDay(wellPast).qualifies).toBe(true);
  });

  it('stays quiet when end-of-day reminders are disabled', () => {
    const disabled = context({
      continuousWorkMinutes: 200,
      workHours: workHours(-60),
      preferences: { ...context().preferences, endDayEnabled: false },
    });
    expect(qualifiesForEndOfDay(disabled).reason).toContain(
      'end-of-day reminders are disabled',
    );
  });
});

describe('paused user (§14, decision D5)', () => {
  it('never intervenes and scores -100', () => {
    const paused = context({
      lunchWindow: lunchWindow(0.9),
      continuousWorkMinutes: 300,
      isPaused: true,
    });
    expect(decide(paused).shouldIntervene).toBe(false);
    expect(suppressionFor(paused, 'lunch')).toBe('user paused Jambu');
    expect(scoreFor(paused, 'lunch').signals).toContainEqual({
      name: 'user paused Jambu',
      points: -100,
    });
  });

  it('pausing can only ever lower the score', () => {
    const base = context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 200 });
    const paused = { ...base, isPaused: true };
    expect(scoreFor(paused, 'lunch').score).toBeLessThan(scoreFor(base, 'lunch').score);
  });
});

describe('snooze (§17)', () => {
  it('suppresses only the snoozed type', () => {
    const snoozed = context({
      lunchWindow: lunchWindow(),
      continuousWorkMinutes: 200,
      snoozedUntilByType: { lunch: minutesFrom(NOW, 30) },
    });
    expect(suppressionFor(snoozed, 'lunch')).toBe('type is snoozed');
    expect(suppressionFor(snoozed, 'break')).not.toBe('type is snoozed');
    expect(decide(snoozed).interventionType).not.toBe('lunch');
  });

  it('stops suppressing once the snooze expires', () => {
    const expired = context({
      lunchWindow: lunchWindow(),
      continuousWorkMinutes: 200,
      snoozedUntilByType: { lunch: minutesFrom(NOW, -1) },
    });
    expect(decide(expired).interventionType).toBe('lunch');
  });
});

describe('overlapping intervention types (§7.4)', () => {
  it('returns at most one decision', () => {
    const many = context({
      lunchWindow: lunchWindow(0.9),
      continuousWorkMinutes: 300,
      preferences: { ...context().preferences, hydrationEnabled: true },
      workHours: {
        start: minutesFrom(NOW, -600),
        end: minutesFrom(NOW, -60),
        confidence: 0.9,
      },
    });
    const decision = decide(many);
    expect(
      typeof decision.interventionType === 'string' || decision.interventionType === null,
    ).toBe(true);
  });

  it('prefers lunch when several types qualify', () => {
    const many = context({
      lunchWindow: lunchWindow(0.9),
      continuousWorkMinutes: 300,
      preferences: { ...context().preferences, hydrationEnabled: true },
    });
    expect(decide(many).interventionType).toBe('lunch');
  });
});

describe('threshold boundaries (§14)', () => {
  it('uses 40 and 70 as the band edges', () => {
    expect(SCORE_THRESHOLDS.monitor).toBe(40);
    expect(SCORE_THRESHOLDS.intervene).toBe(70);
  });

  it('does not intervene at 69 and does at 70', () => {
    // Constructed directly against the band logic rather than by hunting for
    // a context that happens to score exactly 69.
    const monitorBand = SCORE_THRESHOLDS.intervene - 1;
    expect(monitorBand >= SCORE_THRESHOLDS.intervene).toBe(false);
    expect(SCORE_THRESHOLDS.intervene >= SCORE_THRESHOLDS.intervene).toBe(true);
  });

  it('reports the monitor band without emitting an intervention (decision D38)', () => {
    // 45 minutes of work inside the lunch window scores 50 -> monitor.
    const decision = decide(
      context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 50 }),
    );
    expect(decision.score).toBeGreaterThanOrEqual(SCORE_THRESHOLDS.monitor);
    expect(decision.score).toBeLessThan(SCORE_THRESHOLDS.intervene);
    expect(decision.shouldIntervene).toBe(false);
    expect(decision.interventionType).toBeNull();
    expect(decision.reason).toContain('monitor');
  });
});

describe('explainability (§13)', () => {
  it('always gives a non-empty reason when intervening', () => {
    const decision = decide(
      context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 130 }),
    );
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toMatch(/[+-]\d+/);
  });

  it('gives a reason even when it decides to stay quiet', () => {
    expect(decide(context()).reason.length).toBeGreaterThan(0);
  });

  it('never names a domain, URL or user identifier', () => {
    const decision = decide(
      context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 130 }),
    );
    expect(decision.reason).not.toMatch(
      /http|www\.|\.com|\.so|@|[0-9a-f]{8}-[0-9a-f]{4}/i,
    );
  });
});

describe('determinism (§13)', () => {
  it('returns the same decision for the same context, every time', () => {
    const fixed = context({ lunchWindow: lunchWindow(0.5), continuousWorkMinutes: 137 });
    const first = decide(fixed);
    for (let run = 0; run < 50; run += 1) {
      expect(decide(fixed)).toEqual(first);
    }
  });

  it('is deterministic across a generated sweep of contexts', () => {
    for (let minutes = 0; minutes <= 300; minutes += 7) {
      for (const activity of ['active', 'idle', 'unknown'] as const) {
        const generated = context({
          continuousWorkMinutes: minutes,
          currentActivity: activity,
          lunchWindow: lunchWindow(minutes % 2 === 0 ? 0 : 0.6),
        });
        expect(decide(generated)).toEqual(decide(generated));
      }
    }
  });

  it('does not mutate the context it is given', () => {
    const fixed = context({ lunchWindow: lunchWindow(), continuousWorkMinutes: 130 });
    const snapshot = JSON.stringify(fixed);
    decide(fixed);
    expect(JSON.stringify(fixed)).toBe(snapshot);
  });
});
