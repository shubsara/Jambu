import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { INTERVENTION_TYPES } from '@jambu/shared-types';
import { describe, expect, it } from 'vitest';

import {
  PERSONAS,
  UnknownPersonaError,
  getMessages,
  getPersona,
  isKnownPersona,
} from './registry.js';

describe('persona registry', () => {
  it('ships exactly one persona in the MVP (decision D10)', () => {
    expect(Object.keys(PERSONAS)).toEqual(['mom']);
  });

  it('gives every intervention type at least one message, so resolution cannot fall through', () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const type of INTERVENTION_TYPES) {
        expect(persona.messages[type].length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves a known persona', () => {
    expect(getPersona('mom').displayName).toBe('Mom');
  });

  it('throws on an unknown persona instead of falling back silently', () => {
    expect(() => getPersona('dad')).toThrow(UnknownPersonaError);
    expect(() => getPersona('dad')).toThrow(/Unknown persona "dad"/);
  });

  it('names the personas it does know, so the failure is actionable', () => {
    expect(() => getPersona('typo')).toThrow(/Known personas: mom/);
  });

  it('does not resolve inherited Object properties as personas', () => {
    expect(isKnownPersona('constructor')).toBe(false);
    expect(isKnownPersona('toString')).toBe(false);
    expect(() => getPersona('constructor')).toThrow(UnknownPersonaError);
  });

  it('reports known personas for input validation', () => {
    expect(isKnownPersona('mom')).toBe(true);
    expect(isKnownPersona('dad')).toBe(false);
  });

  it('returns the catalogue for a persona and type', () => {
    expect(getMessages('mom', 'hydration')).toContain('Hey! Have you had some water? 💧');
  });
});

describe('Care Engine independence (decision D10)', () => {
  it('care-engine does not depend on this package, so a new persona needs no engine change', () => {
    const enginePkgUrl = new URL('../../care-engine/package.json', import.meta.url);
    const pkg: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(fileURLToPath(enginePkgUrl), 'utf8'),
    );
    expect(pkg.dependencies?.['@jambu/message-templates']).toBeUndefined();
  });
});
