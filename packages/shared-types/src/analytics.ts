/**
 * Analytics event contract (CLAUDE.md §29, decisions D111-D113).
 *
 * A **closed** registry: the twelve §29 event names, one payload shape each,
 * and a fixed set of fields any payload may carry. Closedness is the point.
 * ARCHITECTURE.md §10 requires "an assertion over every emitted analytics
 * payload proves no domain, URL, page content, email or token is present",
 * and an open payload type cannot be asserted over exhaustively.
 *
 * Shared rather than duplicated per app (CLAUDE.md §32): the API emits nine of
 * these events and the extension three, and a contract that drifted between
 * them would make the two halves of a funnel incomparable.
 *
 * **What is deliberately absent.** No domain, URL, page content, email, token,
 * preference value, or free-form string. Every field below is a fixed enum, an
 * integer, an ISO timestamp, or a UUID. None is sourced from a tab, a page, or
 * a stored profile's email.
 */
import type { InterventionTrigger, InterventionType } from './intervention.js';
import type { IsoTimestamp } from './time.js';

/**
 * The twelve events of CLAUDE.md §29, in the order that section lists them.
 *
 * `uninstall` is absent because §29 does not name it; §30's "uninstall rate"
 * is therefore not derivable (see {@link UNDERIVABLE_METRICS}).
 */
export const ANALYTICS_EVENT_NAMES = [
  'onboarding_started',
  'onboarding_completed',
  'activity_session_started',
  'activity_session_completed',
  'intervention_shown',
  'intervention_confirmed',
  'intervention_snoozed',
  'intervention_dismissed',
  'intervention_expired',
  'jambu_paused',
  'jambu_resumed',
  'settings_changed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/**
 * Carried by every event (decision D113).
 *
 * `userId` is nullable on purpose. `onboarding_started` fires when the
 * onboarding page mounts (D114), and the account is not created until the
 * second step, so a first-time user genuinely has no id yet. A null there is
 * correct data, not a defect - and it is why the onboarding funnel is
 * population-level rather than per-user.
 *
 * `userId` is the `users.id` UUID. It is an identifier, accepted deliberately
 * under D113: retention and per-user rates are otherwise uncomputable, and it
 * discloses nothing about what the user works on. It is never an email.
 */
export interface AnalyticsEnvelope {
  readonly event: AnalyticsEventName;
  /** ISO 8601 UTC, the wire format for every Jambu timestamp (§28). */
  readonly occurredAt: IsoTimestamp;
  /** `users.id`, or null where no account exists yet. Never an email. */
  readonly userId: string | null;
}

interface Plain<N extends AnalyticsEventName> extends AnalyticsEnvelope {
  readonly event: N;
}

/** Onboarding UI opened (D114). `userId` is null for a first-time user. */
export type OnboardingStartedEvent = Plain<'onboarding_started'>;

/** The incomplete -> complete transition actually happened (resolution A2). */
export type OnboardingCompletedEvent = Plain<'onboarding_completed'>;

export type ActivitySessionStartedEvent = Plain<'activity_session_started'>;

export interface ActivitySessionCompletedEvent extends Plain<'activity_session_completed'> {
  /** Session duration. §9 permits duration; the domain is never included. */
  readonly activeSeconds: number;
}

/**
 * An intervention row was created and delivery was attempted.
 *
 * **Decision D111 - this is not an impression.** `interventions.shown_at`
 * keeps its creation-time semantics (D70): injection can fail and a native
 * notification can be suppressed by the OS, so a row can exist while nothing
 * reached a screen. Any rate computed against this event is
 * response-per-delivery-attempt, never response-per-impression.
 */
export interface InterventionShownEvent extends Plain<'intervention_shown'> {
  readonly interventionType: InterventionType;
  readonly trigger: InterventionTrigger;
  /** The score the engine produced. §13 requires it be explainable. */
  readonly score: number;
}

interface InterventionOutcome<N extends AnalyticsEventName> extends Plain<N> {
  readonly interventionType: InterventionType;
}

export type InterventionConfirmedEvent = InterventionOutcome<'intervention_confirmed'>;
export type InterventionSnoozedEvent = InterventionOutcome<'intervention_snoozed'>;
export type InterventionDismissedEvent = InterventionOutcome<'intervention_dismissed'>;
export type InterventionExpiredEvent = InterventionOutcome<'intervention_expired'>;

export interface JambuPausedEvent extends Plain<'jambu_paused'> {
  /** Minutes from the existing pause choices; null for "rest of day". */
  readonly pauseDurationMinutes: number | null;
}

export type JambuResumedEvent = Plain<'jambu_resumed'>;

export interface SettingsChangedEvent extends Plain<'settings_changed'> {
  /**
   * Preference **key names** only, never their values.
   *
   * `workStart`'s value would disclose the user's daily schedule, so no value
   * ever enters a payload. The names alone answer "which controls do people
   * actually touch".
   */
  readonly changedFields: readonly PreferenceFieldName[];
}

/** The closed union every emitter and the privacy assertion range over. */
export type AnalyticsEvent =
  | OnboardingStartedEvent
  | OnboardingCompletedEvent
  | ActivitySessionStartedEvent
  | ActivitySessionCompletedEvent
  | InterventionShownEvent
  | InterventionConfirmedEvent
  | InterventionSnoozedEvent
  | InterventionDismissedEvent
  | InterventionExpiredEvent
  | JambuPausedEvent
  | JambuResumedEvent
  | SettingsChangedEvent;

/**
 * Preference keys that may appear in `changedFields`.
 *
 * An allowlist rather than an open string: it is what stops a future caller
 * from putting a value, a label, or anything user-typed into this array.
 */
export const PREFERENCE_FIELD_NAMES = [
  'workStart',
  'workEnd',
  'lunchEnabled',
  'breakEnabled',
  'hydrationEnabled',
  'endDayEnabled',
  'persona',
  'timezone',
] as const;

export type PreferenceFieldName = (typeof PREFERENCE_FIELD_NAMES)[number];

/** Fields present on every event. */
export const ANALYTICS_ENVELOPE_FIELDS = ['event', 'occurredAt', 'userId'] as const;

/** The only event-specific fields decision D113 permits. */
export const ANALYTICS_PAYLOAD_FIELDS = [
  'interventionType',
  'trigger',
  'score',
  'activeSeconds',
  'pauseDurationMinutes',
  'changedFields',
] as const;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...ANALYTICS_ENVELOPE_FIELDS,
  ...ANALYTICS_PAYLOAD_FIELDS,
]);

const EVENT_NAMES: ReadonlySet<string> = new Set<string>(ANALYTICS_EVENT_NAMES);
const PREFERENCE_NAMES: ReadonlySet<string> = new Set<string>(PREFERENCE_FIELD_NAMES);

/**
 * Value patterns that must never appear, whatever the field is called.
 *
 * The field allowlist above already makes these unreachable through the typed
 * API. They are kept as the second half of a belt-and-braces check, because
 * ARCHITECTURE.md §10 asks for proof about *payloads*, not about types - and a
 * payload can be built by a caller that ignored the types.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'a URL', pattern: /^[a-z][a-z0-9+.-]*:\/\//i },
  { label: 'a protocol-relative URL', pattern: /^\/\// },
  { label: 'an email address', pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/ },
  { label: 'a JWT-shaped credential', pattern: /eyJ[A-Za-z0-9_-]{10,}/ },
  // A bare hostname: two or more dot-separated labels ending in a TLD.
  { label: 'a domain', pattern: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i },
];

/**
 * The §10 privacy assertion, as a function.
 *
 * Returns a human-readable reason for every violation, and an empty array for
 * a payload that is safe to emit. Exported so the emitters can fail closed at
 * runtime and the tests can range over all twelve shapes.
 */
export function findPrivacyViolations(payload: unknown): string[] {
  const problems: string[] = [];

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return ['payload is not an object'];
  }

  const record = payload as Record<string, unknown>;

  if (!EVENT_NAMES.has(String(record['event']))) {
    problems.push(`"${String(record['event'])}" is not a §29 event name`);
  }

  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      problems.push(`field "${key}" is not in the D113 contract`);
      continue;
    }

    if (key === 'changedFields') {
      if (!Array.isArray(value)) {
        problems.push('changedFields must be an array');
        continue;
      }
      for (const entry of value) {
        if (typeof entry !== 'string' || !PREFERENCE_NAMES.has(entry)) {
          problems.push(
            `changedFields contains "${String(entry)}", not a preference key`,
          );
        }
      }
      continue;
    }

    if (typeof value === 'string') {
      // `userId` is a UUID and `occurredAt` an ISO timestamp; neither can
      // match the patterns below, so no field needs an exemption.
      for (const { label, pattern } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          problems.push(`field "${key}" looks like ${label}`);
        }
      }
      continue;
    }

    if (value !== null && typeof value !== 'number') {
      problems.push(`field "${key}" has an unexpected type`);
    }
  }

  return problems;
}

/**
 * §30 metrics that the twelve §29 events cannot produce.
 *
 * Recorded here rather than in a comment so the limitation travels with the
 * contract. P14 deliberately does not invent definitions for any of these
 * (decisions D111-D113); each needs a decision of its own.
 */
export const UNDERIVABLE_METRICS = [
  // §29 names no uninstall event and P14 does not add one.
  'uninstall rate',
  // §30 names the primary metric but never defines "meaningful".
  'meaningful intervention engagement',
  // Derivable only once a cohort anchor is chosen; §30 names none.
  'Day-1 retention',
  'Day-7 retention',
  // `jambu_paused` gives the numerator; §30 defines no denominator.
  'pause rate',
] as const;
