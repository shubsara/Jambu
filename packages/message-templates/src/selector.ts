/**
 * Deterministic message selection.
 *
 * CLAUDE.md §20 requires deterministic templates, and §21 forbids an LLM in
 * the MVP. Variety comes from rotating a fixed catalogue, not from generation.
 *
 * This module is pure: the caller supplies the seed, so the same inputs always
 * produce the same message. That keeps message choice reproducible in tests
 * and in the intervention records written to the database.
 */

import type { InterventionType, PersonaId } from '@jambu/shared-types';

import { getMessages } from './registry.js';

/** What the caller must supply to resolve a message. */
export interface MessageRequest {
  readonly personaId: PersonaId;
  readonly interventionType: InterventionType;
  /**
   * Any non-negative integer. The caller decides what it means — an
   * intervention count, a timestamp, a counter — but the same seed with the
   * same previous message always yields the same result.
   */
  readonly seed: number;
  /**
   * The message shown last time for this type, if any. The selector will not
   * return it again when the catalogue has an alternative, so the user does
   * not see the same words twice in a row.
   */
  readonly previousMessage?: string;
}

/**
 * Pick a message from a catalogue.
 *
 * Deterministic for a given `(messages, seed, previousMessage)`, and never
 * returns `previousMessage` unless the catalogue has only one entry.
 */
export function selectFrom(
  messages: readonly [string, ...string[]],
  seed: number,
  previousMessage?: string,
): string {
  const count = messages.length;
  const start = ((Math.trunc(seed) % count) + count) % count;

  const first = messages[start] ?? messages[0];
  if (count === 1 || first !== previousMessage) {
    return first;
  }

  // Only reachable when the seed landed on the previous message and an
  // alternative exists: step forward one slot, wrapping.
  const next = (start + 1) % count;
  return messages[next] ?? messages[0];
}

/**
 * Resolve the words Jambu says for a decision the Care Engine already made.
 *
 * Throws `UnknownPersonaError` for an unregistered persona rather than
 * silently substituting a default — see `registry.ts`.
 */
export function selectMessage(request: MessageRequest): string {
  const messages = getMessages(request.personaId, request.interventionType);
  return selectFrom(messages, request.seed, request.previousMessage);
}
