/**
 * The onboarding flow, as rules rather than pixels (decisions D85-D95).
 *
 * The cases that matter most are the ones that would let onboarding grow: a
 * fifth step, a sixth required input, or a schedule question. Each of those
 * fails here rather than in review.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_REQUIRED_INPUTS,
  MAX_STEPS,
  REQUIRED_INPUTS,
  STEPS,
  back,
  fromProgress,
  initialState,
  isLastStep,
  next,
  stepIndex,
  toProgress,
  toSubmission,
  toggle,
  withTimezone,
} from './machine.js';

const start = () => initialState('Asia/Kolkata');

describe('the two-minute bound (decision D95)', () => {
  it('has no more steps than the budget allows', () => {
    expect(STEPS.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('asks the user to type no more than the budget allows', () => {
    expect(REQUIRED_INPUTS.length).toBeLessThanOrEqual(MAX_REQUIRED_INPUTS);
  });

  it('requires only an email and a password', () => {
    // Everything else is pre-filled or pre-set, so a user can finish by
    // clicking through.
    expect([...REQUIRED_INPUTS]).toEqual(['email', 'password']);
  });
});

describe('what onboarding may collect (CLAUDE.md §3.2, decisions D88, D10, A6)', () => {
  it('has no field for any schedule, work hours, persona or name', () => {
    // The schema is the guard, not the rendered copy: a question with nowhere
    // to be stored cannot reach the API however it is worded.
    expect(Object.keys(start()).sort()).toEqual([
      'breakEnabled',
      'endDayEnabled',
      'hydrationEnabled',
      'lunchEnabled',
      'step',
      'timezone',
    ]);
  });

  it('submits exactly the toggles, the timezone and the completion flag', () => {
    expect(Object.keys(toSubmission(start())).sort()).toEqual([
      'breakEnabled',
      'endDayEnabled',
      'hydrationEnabled',
      'lunchEnabled',
      'onboardingCompleted',
      'timezone',
    ]);
  });

  it('persists no schedule field either', () => {
    expect(Object.keys(toProgress(start())).sort()).toEqual([
      'breakEnabled',
      'endDayEnabled',
      'hydrationEnabled',
      'lunchEnabled',
      'step',
      'timezone',
    ]);
  });
});

describe('defaults (decisions D7, D89)', () => {
  it('starts hydration off and the other three on', () => {
    const state = start();
    expect(state.hydrationEnabled).toBe(false);
    expect(state.lunchEnabled).toBe(true);
    expect(state.breakEnabled).toBe(true);
    expect(state.endDayEnabled).toBe(true);
  });

  it('leaves hydration off when the user simply clicks through', () => {
    expect(toSubmission(start()).hydrationEnabled).toBe(false);
  });

  it('turns hydration on only when asked', () => {
    expect(toggle(start(), 'hydrationEnabled').hydrationEnabled).toBe(true);
  });

  it('pre-fills the detected timezone', () => {
    expect(start().timezone).toBe('Asia/Kolkata');
  });
});

describe('moving through the flow', () => {
  it('walks welcome → account → timezone → checkins', () => {
    let state = start();
    const visited = [state.step];
    while (!isLastStep(state)) {
      state = next(state);
      visited.push(state.step);
    }
    expect(visited).toEqual(['welcome', 'account', 'timezone', 'checkins']);
  });

  it('does not run past the last step', () => {
    const last = { ...start(), step: 'checkins' as const };
    expect(next(last).step).toBe('checkins');
  });

  it('does not run before the first', () => {
    expect(back(start()).step).toBe('welcome');
  });

  it('keeps answers when moving back and forward', () => {
    const chosen = toggle({ ...start(), step: 'checkins' as const }, 'hydrationEnabled');
    expect(next(back(chosen)).hydrationEnabled).toBe(true);
  });

  it('never mutates the state it is given', () => {
    const state = start();
    next(state);
    toggle(state, 'lunchEnabled');
    withTimezone(state, 'UTC');
    expect(state).toEqual(start());
  });
});

describe('resuming an abandoned flow (decision D92)', () => {
  it('starts fresh when there is nothing stored', () => {
    expect(fromProgress(null, 'UTC')).toEqual(initialState('UTC'));
  });

  it('round-trips every step', () => {
    for (const step of STEPS) {
      const state = { ...start(), step };
      expect(fromProgress(toProgress(state), 'UTC')).toEqual(state);
    }
  });

  it('restores the answers, not just the position', () => {
    const chosen = toggle(toggle(start(), 'hydrationEnabled'), 'breakEnabled');
    const restored = fromProgress(toProgress(chosen), 'UTC');

    expect(restored.hydrationEnabled).toBe(true);
    expect(restored.breakEnabled).toBe(false);
  });

  it('falls back to the detected timezone when none was stored', () => {
    expect(fromProgress({ step: 1 }, 'Europe/Berlin').timezone).toBe('Europe/Berlin');
  });

  it('survives a stored step that no longer exists', () => {
    // A future version with fewer steps must not strand someone mid-flow.
    expect(fromProgress({ step: 99 }, 'UTC').step).toBe(STEPS[STEPS.length - 1]);
    expect(fromProgress({ step: -3 }, 'UTC').step).toBe('welcome');
  });

  it('ignores a stored field the flow does not have', () => {
    const restored = fromProgress(
      { step: 2, lunchTime: '13:00' } as never,
      'UTC',
    ) as unknown as Record<string, unknown>;
    expect(restored['lunchTime']).toBeUndefined();
  });
});

describe('completion is explicit (resolution A2)', () => {
  it('always submits the flag, never omits it', () => {
    expect(toSubmission(start()).onboardingCompleted).toBe(true);
  });
});

describe('step ordering', () => {
  it('reports a stable index for each step', () => {
    expect(STEPS.map(stepIndex)).toEqual([0, 1, 2, 3]);
  });
});
