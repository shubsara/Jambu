import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  INTERVENTION_RESPONSE_TYPES,
  INTERVENTION_TYPES,
  type InterventionResponseType,
  type InterventionType,
} from './intervention.js';

describe('intervention unions', () => {
  it('carries exactly the four MVP intervention types (CLAUDE.md §2)', () => {
    expect([...INTERVENTION_TYPES]).toEqual([
      'lunch',
      'break',
      'hydration',
      'end_of_day',
    ]);
  });

  it('carries exactly the five responses (CLAUDE.md §18)', () => {
    expect([...INTERVENTION_RESPONSE_TYPES]).toEqual([
      'confirmed',
      'not_yet',
      'snoozed',
      'dismissed',
      'expired',
    ]);
  });

  it('keeps the runtime list and the type in step', () => {
    expectTypeOf<(typeof INTERVENTION_TYPES)[number]>().toEqualTypeOf<InterventionType>();
    expectTypeOf<
      (typeof INTERVENTION_RESPONSE_TYPES)[number]
    >().toEqualTypeOf<InterventionResponseType>();
  });

  it('is exhaustively narrowable, so a new type breaks the build rather than passing silently', () => {
    const describeType = (type: InterventionType): string => {
      switch (type) {
        case 'lunch':
          return 'lunch';
        case 'break':
          return 'break';
        case 'hydration':
          return 'hydration';
        case 'end_of_day':
          return 'end_of_day';
        default: {
          const unreachable: never = type;
          return unreachable;
        }
      }
    };

    for (const type of INTERVENTION_TYPES) {
      expect(describeType(type)).toBe(type);
    }
  });
});
