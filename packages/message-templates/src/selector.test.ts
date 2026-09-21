import { INTERVENTION_TYPES } from '@jambu/shared-types';
import { describe, expect, it } from 'vitest';

import { getMessages } from './registry.js';
import { selectFrom, selectMessage } from './selector.js';

const CATALOGUE = ['a', 'b', 'c'] as const satisfies readonly [string, ...string[]];

describe('selectFrom', () => {
  it('is deterministic for a given seed', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      expect(selectFrom(CATALOGUE, seed)).toBe(selectFrom(CATALOGUE, seed));
    }
  });

  it('walks the catalogue as the seed advances', () => {
    expect([0, 1, 2, 3].map((s) => selectFrom(CATALOGUE, s))).toEqual([
      'a',
      'b',
      'c',
      'a',
    ]);
  });

  it('never repeats the previous message when an alternative exists', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      for (const previous of CATALOGUE) {
        expect(selectFrom(CATALOGUE, seed, previous)).not.toBe(previous);
      }
    }
  });

  it('stays deterministic when avoiding a repeat', () => {
    expect(selectFrom(CATALOGUE, 0, 'a')).toBe(selectFrom(CATALOGUE, 0, 'a'));
    expect(selectFrom(CATALOGUE, 0, 'a')).toBe('b');
  });

  it('returns the only message when the catalogue has one entry', () => {
    const single = ['only'] as const satisfies readonly [string, ...string[]];
    expect(selectFrom(single, 7, 'only')).toBe('only');
  });

  it('handles negative and fractional seeds without going out of bounds', () => {
    for (const seed of [-1, -7, -100, 2.9, -3.5]) {
      expect(CATALOGUE).toContain(selectFrom(CATALOGUE, seed));
    }
  });

  it('ignores a previous message that is not in the catalogue', () => {
    expect(selectFrom(CATALOGUE, 0, 'not-in-list')).toBe('a');
  });
});

describe('selectMessage', () => {
  it('resolves a real message for every intervention type', () => {
    for (const type of INTERVENTION_TYPES) {
      const message = selectMessage({
        personaId: 'mom',
        interventionType: type,
        seed: 0,
      });
      expect(getMessages('mom', type)).toContain(message);
    }
  });

  it('is deterministic end to end', () => {
    const request = { personaId: 'mom', interventionType: 'lunch', seed: 3 } as const;
    expect(selectMessage(request)).toBe(selectMessage(request));
  });

  it('avoids repeating the previous message for a real persona', () => {
    for (const type of INTERVENTION_TYPES) {
      const catalogue = getMessages('mom', type);
      if (catalogue.length < 2) continue;
      for (let seed = 0; seed < 10; seed += 1) {
        const previous = catalogue[seed % catalogue.length] as string;
        expect(
          selectMessage({
            personaId: 'mom',
            interventionType: type,
            seed,
            previousMessage: previous,
          }),
        ).not.toBe(previous);
      }
    }
  });

  it('propagates an unknown persona rather than substituting one', () => {
    expect(() =>
      selectMessage({ personaId: 'dad', interventionType: 'lunch', seed: 0 }),
    ).toThrow(/Unknown persona/);
  });
});
