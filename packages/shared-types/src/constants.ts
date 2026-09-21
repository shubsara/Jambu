/**
 * Shared constants.
 *
 * Every value here is defined exactly once, in this file, and imported
 * everywhere else. The activity tracker, the API, the Care Engine and the
 * tests must all agree on these numbers — a second copy is a bug.
 */

import type { TimeOfDay } from './time.js';

/**
 * Decision D6 — continuous work is the current active session. An idle period
 * of at least this many minutes ends that session; shorter gaps are bridged
 * and do not reset the counter.
 *
 * Used identically by the activity tracker, the API, the Care Engine and their
 * tests. See docs/ARCHITECTURE.md §6.
 */
export const IDLE_BREAK_THRESHOLD_MINUTES = 10;

/**
 * Decision D8 — the fallback lunch window for users without enough
 * observations to learn one, expressed in the user's local time.
 *
 * This is a fallback, never a schedule: once routine learning reaches
 * {@link MIN_OBSERVATIONS_FOR_PERSONALIZATION} observations the learned window
 * takes over, and {@link LunchWindow.source} records which one was used.
 * See docs/ARCHITECTURE.md §7.3.
 */
export const DEFAULT_LUNCH_WINDOW_START: TimeOfDay = '12:30';

/** Decision D8 — end of the fallback lunch window, in the user's local time. */
export const DEFAULT_LUNCH_WINDOW_END: TimeOfDay = '14:30';

/**
 * Confidence reported for the default lunch window. Zero, because nothing has
 * been learned yet.
 */
export const DEFAULT_LUNCH_WINDOW_CONFIDENCE = 0;

/**
 * CLAUDE.md §16 — below this many observations Jambu uses generic default
 * behaviour and does not personalize.
 */
export const MIN_OBSERVATIONS_FOR_PERSONALIZATION = 3;

/**
 * Decision D25 — ingest bounds for `POST /api/activity/session`.
 *
 * Defined here rather than in the API because the extension must respect the
 * same numbers when it chunks its buffer (P9). Values outside these bounds are
 * rejected, never silently clamped: a clamped value would quietly corrupt
 * `continuousWorkMinutes`, and every Care Engine decision reads from that.
 */

/** Maximum aggregated sessions accepted in a single batch. */
export const MAX_ACTIVITY_SESSIONS_PER_BATCH = 500;

/** Maximum active seconds in one session — 24 hours. */
export const MAX_ACTIVE_SECONDS_PER_SESSION = 86_400;

/** How far into the future `startedAt` may be, to tolerate clock skew. */
export const MAX_CLOCK_SKEW_MINUTES = 10;

/** How old a submitted session may be before it is refused. */
export const MAX_SESSION_AGE_DAYS = 30;
