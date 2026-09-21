/**
 * @jambu/message-templates
 *
 * How Jambu says things. Whether Jambu says anything at all is decided by
 * `@jambu/care-engine`, which never imports this package (CLAUDE.md §8,
 * decision D10).
 */

export type { Persona, PersonaTone } from './persona.js';
export { MOM_PERSONA } from './personas/mom.js';
export {
  PERSONAS,
  UnknownPersonaError,
  getMessages,
  getPersona,
  isKnownPersona,
} from './registry.js';
export type { MessageRequest } from './selector.js';
export { selectFrom, selectMessage } from './selector.js';
