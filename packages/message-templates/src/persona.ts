/**
 * The persona contract (decision D10).
 *
 * A persona is *how Jambu speaks*. It is deliberately separate from *whether
 * Jambu speaks*, which is the Care Engine's job (CLAUDE.md §8).
 *
 * The Care Engine never imports this package. Adding a persona therefore
 * cannot require an engine change, which is the actual requirement in D10.
 * See docs/ARCHITECTURE.md §8.
 */

import type { InterventionType, PersonaId } from '@jambu/shared-types';

/**
 * Tone metadata. Descriptive, not executable: it documents the voice for
 * whoever writes the next persona, and gives later analysis something to
 * compare personas on.
 */
export interface PersonaTone {
  readonly warmth: 'high' | 'medium' | 'low';
  readonly formality: 'casual' | 'neutral' | 'formal';
  /** A one-line description of the voice. */
  readonly description: string;
}

export interface Persona {
  readonly id: PersonaId;
  /** How the persona refers to itself, e.g. `Mom`. */
  readonly displayName: string;
  /** The sign-off on the care card, e.g. `— Mom ❤️`. */
  readonly signature: string;
  /** Identifier for the avatar asset; resolved by the UI, not here. */
  readonly avatarAssetId: string;
  readonly tone: PersonaTone;
  /**
   * The message catalogue. Every intervention type must have at least one
   * message, so resolution can never fall through to an empty list.
   */
  readonly messages: Readonly<Record<InterventionType, readonly [string, ...string[]]>>;
}
