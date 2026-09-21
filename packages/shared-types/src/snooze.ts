/**
 * Snooze state (decision D5).
 *
 * CLAUDE.md §17 requires Jambu to respect snooze. Snooze is scoped to a single
 * intervention type, so snoozing lunch does not silence breaks.
 * See docs/ARCHITECTURE.md §11.7.
 */

import type { InterventionType } from './intervention.js';
import type { IsoTimestamp } from './time.js';

export interface InterventionSnooze {
  readonly type: InterventionType;
  readonly snoozedUntil: IsoTimestamp;
}
