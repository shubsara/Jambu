/**
 * Interventions and their responses (CLAUDE.md §13, §18).
 */

import type { IsoTimestamp } from './time.js';

/**
 * The four MVP intervention types (CLAUDE.md §2).
 *
 * CLAUDE.md §2: "Do not expand the intervention catalog without explicit
 * approval."
 */
export type InterventionType = 'lunch' | 'break' | 'hydration' | 'end_of_day';

/** Every intervention type, for exhaustive iteration in tests and registries. */
export const INTERVENTION_TYPES = [
  'lunch',
  'break',
  'hydration',
  'end_of_day',
] as const satisfies readonly InterventionType[];

/**
 * How the user answered a care card (CLAUDE.md §18).
 *
 * `expired` is not a user action: it is written by the server sweep when a
 * card was never answered before {@link Intervention.expiresAt}.
 */
export type InterventionResponseType =
  'confirmed' | 'not_yet' | 'snoozed' | 'dismissed' | 'expired';

/** Every response value, for exhaustive iteration in tests. */
export const INTERVENTION_RESPONSE_TYPES = [
  'confirmed',
  'not_yet',
  'snoozed',
  'dismissed',
  'expired',
] as const satisfies readonly InterventionResponseType[];

/**
 * Which evaluation path produced the intervention (decision D4).
 *
 * `activity_sync` is the primary path — the decision rides back on the
 * activity ingest response. `alarm_poll` is the chrome.alarms fallback that
 * covers idle users and failed syncs. See docs/ARCHITECTURE.md §5.
 */
export type InterventionTrigger = 'activity_sync' | 'alarm_poll';

/**
 * How the intervention reached the user (decision D3).
 *
 * `care_card` is the styled content-script overlay. `notification` is the
 * native Chrome fallback used when no tab can be injected — it cannot carry
 * the CLAUDE.md §19 design, which is why it is the fallback.
 * See docs/ARCHITECTURE.md §9.
 */
export type InterventionDelivery = 'care_card' | 'notification';

/** A care card that was created for a user. */
export interface Intervention {
  readonly id: string;
  readonly type: InterventionType;
  readonly persona: string;
  readonly message: string;
  readonly expiresAt: IsoTimestamp;
  readonly shownAt?: IsoTimestamp;
  readonly response?: InterventionResponseType;
  readonly respondedAt?: IsoTimestamp;
}

/** A user's answer to a care card (CLAUDE.md §18). Must be persisted. */
export interface InterventionResponse {
  readonly interventionId: string;
  readonly response: InterventionResponseType;
  readonly respondedAt: IsoTimestamp;
}
