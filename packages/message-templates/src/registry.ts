/**
 * The persona registry (decision D10).
 *
 * Adding a persona means adding one entry here and one file under
 * `personas/`. Nothing in `@jambu/care-engine` changes, because the engine
 * never imports this package. See docs/ARCHITECTURE.md §8.
 */

import type { InterventionType, PersonaId } from '@jambu/shared-types';

import type { Persona } from './persona.js';
import { MOM_PERSONA } from './personas/mom.js';

/**
 * Every persona Jambu can speak as.
 *
 * CLAUDE.md §2 and decision D10: the MVP ships exactly one. Do not add more
 * without explicit product approval.
 */
export const PERSONAS: Readonly<Record<PersonaId, Persona>> = Object.freeze({
  [MOM_PERSONA.id]: MOM_PERSONA,
});

/** Thrown when a persona id does not exist in the registry. */
export class UnknownPersonaError extends Error {
  public readonly personaId: PersonaId;

  public constructor(personaId: PersonaId) {
    super(
      `Unknown persona "${personaId}". Known personas: ${Object.keys(PERSONAS).join(', ')}.`,
    );
    this.name = 'UnknownPersonaError';
    this.personaId = personaId;
  }
}

/**
 * Look up a persona.
 *
 * Throws rather than falling back to a default. A silent fallback would let a
 * typo or a stale `user_preferences.persona` value put words in Jambu's mouth
 * that nobody chose, and the failure would be invisible.
 */
export function getPersona(personaId: PersonaId): Persona {
  // Own-property check first. A plain index would resolve inherited members
  // such as `constructor` or `toString` and hand back an Object.prototype
  // value instead of throwing — and `personaId` originates from
  // `user_preferences.persona`, which is user-controlled input.
  if (!isKnownPersona(personaId)) {
    throw new UnknownPersonaError(personaId);
  }

  const persona = PERSONAS[personaId];
  if (persona === undefined) {
    throw new UnknownPersonaError(personaId);
  }
  return persona;
}

/** Whether a persona id is known, for validating input before storing it. */
export function isKnownPersona(personaId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PERSONAS, personaId);
}

/** The message catalogue for one persona and one intervention type. */
export function getMessages(
  personaId: PersonaId,
  interventionType: InterventionType,
): readonly [string, ...string[]] {
  return getPersona(personaId).messages[interventionType];
}
