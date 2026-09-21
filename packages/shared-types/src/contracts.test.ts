/**
 * Contract tests: the shapes must match CLAUDE.md §11-§18 and the approved
 * additions in docs/ARCHITECTURE.md. These are compile-time assertions — if a
 * field is renamed or dropped, this file stops typechecking.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { ActivitySession, ActivityStatus } from './activity.js';
import type { CareContext, CareDecision } from './care.js';
import type { InterventionResponse } from './intervention.js';
import type { UserPreferences } from './preferences.js';
import type { UserState } from './state.js';

describe('domain contracts', () => {
  it('ActivitySession matches CLAUDE.md §11', () => {
    expectTypeOf<ActivitySession['startedAt']>().toEqualTypeOf<string>();
    expectTypeOf<ActivitySession['endedAt']>().toEqualTypeOf<string>();
    expectTypeOf<ActivitySession['activeSeconds']>().toEqualTypeOf<number>();
    expectTypeOf<ActivitySession>().toHaveProperty('domain');
  });

  it('UserState matches CLAUDE.md §12 plus the approved D5/D8 fields', () => {
    expectTypeOf<UserState['continuousWorkMinutes']>().toEqualTypeOf<number>();
    expectTypeOf<UserState['totalWorkMinutesToday']>().toEqualTypeOf<number>();
    expectTypeOf<UserState['currentActivity']>().toEqualTypeOf<ActivityStatus>();
    expectTypeOf<UserState['paused']>().toEqualTypeOf<boolean>();
    expectTypeOf<UserState>().toHaveProperty('lastBreakMinutesAgo');
    expectTypeOf<UserState>().toHaveProperty('lunchWindow');
    expectTypeOf<UserState>().toHaveProperty('lastLunchConfirmation');
    expectTypeOf<UserState>().toHaveProperty('lastInterventionAt');
  });

  it('CareContext takes the current time as an input, never reading a clock', () => {
    expectTypeOf<CareContext['currentTime']>().toEqualTypeOf<Date>();
    expectTypeOf<CareContext['preferences']>().toEqualTypeOf<UserPreferences>();
    expectTypeOf<CareContext['currentActivity']>().toEqualTypeOf<ActivityStatus>();
    expectTypeOf<CareContext['isPaused']>().toEqualTypeOf<boolean>();
  });

  it('CareDecision matches CLAUDE.md §13 and always carries its arithmetic', () => {
    expectTypeOf<CareDecision['shouldIntervene']>().toEqualTypeOf<boolean>();
    expectTypeOf<CareDecision['score']>().toEqualTypeOf<number>();
    expectTypeOf<CareDecision['reason']>().toEqualTypeOf<string>();
  });

  it('CareDecision carries no message text or persona (CLAUDE.md §8, D10)', () => {
    expectTypeOf<CareDecision>().not.toHaveProperty('message');
    expectTypeOf<CareDecision>().not.toHaveProperty('persona');
    expectTypeOf<CareContext>().not.toHaveProperty('persona');
  });

  it('InterventionResponse matches CLAUDE.md §18', () => {
    expectTypeOf<InterventionResponse['interventionId']>().toEqualTypeOf<string>();
    expectTypeOf<InterventionResponse['respondedAt']>().toEqualTypeOf<string>();
  });

  it('UserPreferences matches CLAUDE.md §22', () => {
    expectTypeOf<UserPreferences['lunchEnabled']>().toEqualTypeOf<boolean>();
    expectTypeOf<UserPreferences['breakEnabled']>().toEqualTypeOf<boolean>();
    expectTypeOf<UserPreferences['hydrationEnabled']>().toEqualTypeOf<boolean>();
    expectTypeOf<UserPreferences['endDayEnabled']>().toEqualTypeOf<boolean>();
  });

  it('keeps pause and snooze out of UserPreferences (decision D5)', () => {
    expectTypeOf<UserPreferences>().not.toHaveProperty('paused');
    expectTypeOf<UserPreferences>().not.toHaveProperty('pausedUntil');
    expectTypeOf<UserPreferences>().not.toHaveProperty('snoozedUntil');
  });
});
