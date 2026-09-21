/**
 * Time and timezone primitives.
 *
 * CLAUDE.md §28: store timestamps in UTC, store the user's IANA timezone, and
 * convert to local time before evaluating anything the user would recognise as
 * a time of day.
 */

/**
 * An ISO 8601 timestamp in UTC, e.g. `2026-09-21T09:40:00Z`.
 *
 * This is the wire format for every timestamp crossing the API boundary.
 * In-memory decision logic uses `Date` instead — see {@link CareContext}.
 */
export type IsoTimestamp = string;

/**
 * A wall-clock time of day in 24-hour `HH:mm` form, e.g. `13:25`.
 *
 * Always interpreted in the user's local timezone, never UTC. Carries no date
 * and no offset, which is precisely why it must never be compared against a
 * UTC timestamp without converting first.
 */
export type TimeOfDay = string;

/**
 * An IANA timezone identifier, e.g. `Asia/Kolkata`.
 *
 * CLAUDE.md §28 — never assume UTC for user-facing decisions.
 */
export type IanaTimeZone = string;
