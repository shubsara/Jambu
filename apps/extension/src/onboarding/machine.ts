/**
 * The onboarding flow as pure data (decisions D85, D92, D95).
 *
 * No `chrome.*`, no clock, no network. The React layer renders whatever this
 * returns, which is what makes the flow testable without a browser and makes
 * the D95 bounds assertable rather than aspirational.
 *
 * **This type is the §3.2 guard.** There is no field for a lunch time, water
 * schedule, break schedule or work hours (D88, constraint 2), so such a
 * question has nowhere to be stored and nothing to submit it with. Work hours
 * keep their 09:00-18:00 registration defaults (D91) until P11 learning
 * supersedes them (D84), and persona is never chosen (D10).
 */
import type { OnboardingSubmission } from '@jambu/shared-types';

export const STEPS = ['welcome', 'account', 'timezone', 'checkins'] as const;
export type StepId = (typeof STEPS)[number];

/**
 * Decision D95 — "under two minutes" made falsifiable.
 *
 * Asserted in `machine.test.ts`, so adding a step or a required field fails
 * the build rather than quietly lengthening the flow.
 */
export const MAX_STEPS = 5;
export const MAX_REQUIRED_INPUTS = 5;

/** Only the account step asks for anything the user must type. */
export const REQUIRED_INPUTS = ['email', 'password'] as const;

export interface OnboardingState {
  readonly step: StepId;
  readonly timezone: string;
  readonly lunchEnabled: boolean;
  readonly breakEnabled: boolean;
  readonly hydrationEnabled: boolean;
  readonly endDayEnabled: boolean;
}

export type ToggleId =
  'lunchEnabled' | 'breakEnabled' | 'hydrationEnabled' | 'endDayEnabled';

/**
 * Decision D89 / D7 — hydration starts **off**, the other three on. The
 * defaults are the recommendation; the user never has to touch this step.
 */
export function initialState(detectedTimezone: string): OnboardingState {
  return {
    step: 'welcome',
    timezone: detectedTimezone,
    lunchEnabled: true,
    breakEnabled: true,
    hydrationEnabled: false,
    endDayEnabled: true,
  };
}

export function stepIndex(step: StepId): number {
  return STEPS.indexOf(step);
}

export function next(state: OnboardingState): OnboardingState {
  const index = stepIndex(state.step);
  const following = STEPS[Math.min(index + 1, STEPS.length - 1)];
  return following === undefined ? state : { ...state, step: following };
}

export function back(state: OnboardingState): OnboardingState {
  const index = stepIndex(state.step);
  const previous = STEPS[Math.max(index - 1, 0)];
  return previous === undefined ? state : { ...state, step: previous };
}

export function toggle(state: OnboardingState, id: ToggleId): OnboardingState {
  return { ...state, [id]: !state[id] };
}

export function withTimezone(state: OnboardingState, timezone: string): OnboardingState {
  return { ...state, timezone };
}

export function isLastStep(state: OnboardingState): boolean {
  return state.step === STEPS[STEPS.length - 1];
}

/**
 * What the final step sends (resolution A2 — completion is explicit).
 *
 * The return type admits nothing beyond the toggles, the timezone and the
 * completion flag.
 */
export function toSubmission(state: OnboardingState): OnboardingSubmission {
  return {
    timezone: state.timezone,
    lunchEnabled: state.lunchEnabled,
    breakEnabled: state.breakEnabled,
    hydrationEnabled: state.hydrationEnabled,
    endDayEnabled: state.endDayEnabled,
    onboardingCompleted: true,
  };
}

/** Narrow the stored progress back into state, ignoring anything unexpected. */
export function fromProgress(
  progress: {
    step?: number;
    timezone?: string;
    lunchEnabled?: boolean;
    breakEnabled?: boolean;
    hydrationEnabled?: boolean;
    endDayEnabled?: boolean;
  } | null,
  detectedTimezone: string,
): OnboardingState {
  const base = initialState(detectedTimezone);
  if (progress === null) {
    return base;
  }

  const index = typeof progress.step === 'number' ? progress.step : 0;
  const step = STEPS[Math.min(Math.max(index, 0), STEPS.length - 1)] ?? base.step;

  return {
    step,
    timezone: progress.timezone ?? base.timezone,
    lunchEnabled: progress.lunchEnabled ?? base.lunchEnabled,
    breakEnabled: progress.breakEnabled ?? base.breakEnabled,
    hydrationEnabled: progress.hydrationEnabled ?? base.hydrationEnabled,
    endDayEnabled: progress.endDayEnabled ?? base.endDayEnabled,
  };
}

export function toProgress(state: OnboardingState): {
  step: number;
  timezone: string;
  lunchEnabled: boolean;
  breakEnabled: boolean;
  hydrationEnabled: boolean;
  endDayEnabled: boolean;
} {
  return {
    step: stepIndex(state.step),
    timezone: state.timezone,
    lunchEnabled: state.lunchEnabled,
    breakEnabled: state.breakEnabled,
    hydrationEnabled: state.hydrationEnabled,
    endDayEnabled: state.endDayEnabled,
  };
}

/**
 * The timezone the browser thinks it is in (ARCHITECTURE §13).
 *
 * Passed into {@link initialState} rather than read inside it, so the machine
 * itself stays free of environment reads.
 */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
