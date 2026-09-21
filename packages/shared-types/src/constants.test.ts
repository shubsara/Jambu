import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LUNCH_WINDOW_CONFIDENCE,
  DEFAULT_LUNCH_WINDOW_END,
  DEFAULT_LUNCH_WINDOW_START,
  IDLE_BREAK_THRESHOLD_MINUTES,
  MIN_OBSERVATIONS_FOR_PERSONALIZATION,
} from './constants.js';

describe('shared constants', () => {
  it('defines the D6 idle threshold as 10 minutes', () => {
    expect(IDLE_BREAK_THRESHOLD_MINUTES).toBe(10);
  });

  it('defines the D8 fallback lunch window as 12:30-14:30 local', () => {
    expect(DEFAULT_LUNCH_WINDOW_START).toBe('12:30');
    expect(DEFAULT_LUNCH_WINDOW_END).toBe('14:30');
  });

  it('reports zero confidence for the default window, so it cannot pass as learned', () => {
    expect(DEFAULT_LUNCH_WINDOW_CONFIDENCE).toBe(0);
  });

  it('does not personalize below three observations (CLAUDE.md §16)', () => {
    expect(MIN_OBSERVATIONS_FOR_PERSONALIZATION).toBe(3);
  });
});
