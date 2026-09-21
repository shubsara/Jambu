/**
 * Proves the acceptance criterion "§20 message strings present verbatim" by
 * parsing CLAUDE.md itself, so the catalogue cannot silently drift from the
 * specification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InterventionType } from '@jambu/shared-types';
import { describe, expect, it } from 'vitest';

import { MOM_PERSONA } from './mom.js';

/** Pull a `const name = [ "..." ];` block out of CLAUDE.md §20. */
function messagesFromSpec(constName: string): string[] {
  const specPath = fileURLToPath(new URL('../../../../CLAUDE.md', import.meta.url));
  const spec = readFileSync(specPath, 'utf8');

  const block = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`).exec(spec);
  if (block === null) {
    throw new Error(`CLAUDE.md §20 no longer contains "${constName}"`);
  }

  return [...(block[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');
}

const SPEC_CONSTANTS: Record<InterventionType, string> = {
  lunch: 'lunchMessages',
  break: 'breakMessages',
  hydration: 'hydrationMessages',
  end_of_day: 'endOfDayMessages',
};

describe('mom persona matches CLAUDE.md §20 verbatim', () => {
  for (const [type, constName] of Object.entries(SPEC_CONSTANTS) as [
    InterventionType,
    string,
  ][]) {
    it(`${type} messages are byte-identical to ${constName}`, () => {
      const expected = messagesFromSpec(constName);
      expect(expected.length).toBeGreaterThan(0);
      expect([...MOM_PERSONA.messages[type]]).toEqual(expected);
    });
  }
});

describe('mom persona presentation', () => {
  it('signs off as CLAUDE.md §19 shows', () => {
    expect(MOM_PERSONA.signature).toBe('— Mom ❤️');
  });

  it('makes no authoritative health claims (CLAUDE.md §40)', () => {
    const forbidden = [
      /you must eat/i,
      /you are dehydrated/i,
      /your body needs/i,
      /medically necessary/i,
      /you are unhealthy/i,
    ];
    const all = Object.values(MOM_PERSONA.messages).flat();
    for (const message of all) {
      for (const pattern of forbidden) {
        expect(message).not.toMatch(pattern);
      }
    }
  });

  it('keeps every message short enough for a compact card (CLAUDE.md §19)', () => {
    for (const message of Object.values(MOM_PERSONA.messages).flat()) {
      expect(message.length).toBeLessThanOrEqual(80);
    }
  });
});
