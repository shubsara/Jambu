/**
 * User state derivation (CLAUDE.md §12, docs/API.md §5).
 *
 * Shape of this phase, deliberately:
 *
 *     activity_sessions ──► pure derivation ──► UserState
 *
 * and never
 *
 *     activity_sessions ──► aggregation ──► stored UserState
 *
 * P4 stores facts; P5 interprets them. Nothing here writes, and no activity
 * history is modified or rewritten — the ten-minute continuity rule is applied
 * as a reading of the rows, not an edit to them (decision D26).
 *
 * `deriveUserState` is pure: it takes `now` as an input and never reads the
 * system clock, performs no I/O, and returns the same state for the same
 * inputs. That is what lets the whole D6 / midnight / DST matrix be tested
 * without a database or a faked clock, and what will let P6 consume a
 * deterministic snapshot.
 */
import {
  ACTIVITY_RECENCY_THRESHOLD_MINUTES,
  DEFAULT_LUNCH_WINDOW_CONFIDENCE,
  DEFAULT_LUNCH_WINDOW_END,
  DEFAULT_LUNCH_WINDOW_START,
  IDLE_BREAK_THRESHOLD_MINUTES,
  type ActivityStatus,
  type IanaTimeZone,
  type LunchWindow,
  type UserState,
} from '@jambu/shared-types';

import { localTimeOnDay, startOfLocalDay } from '../lib/timezone.js';

/** One stored activity session, as read from the database. */
export interface StoredSession {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly activeSeconds: number;
}

/** A learned lunch window, once routine learning exists (P11). */
export interface LearnedLunchWindow {
  /** Local `HH:mm`. */
  readonly start: string;
  /** Local `HH:mm`. */
  readonly end: string;
  readonly confidence: number;
}

export interface DeriveUserStateInput {
  /** The instant being evaluated. Never read from the system clock. */
  readonly now: Date;
  readonly timeZone: IanaTimeZone;
  /** The user's sessions. Order does not matter; they are sorted here. */
  readonly sessions: readonly StoredSession[];
  readonly learnedLunchWindow?: LearnedLunchWindow | undefined;
  readonly lastLunchConfirmation?: Date | undefined;
  readonly lastInterventionAt?: Date | undefined;
  readonly paused: boolean;
}

/** A maximal stretch of work with no gap of {@link IDLE_BREAK_THRESHOLD_MINUTES}. */
interface ContinuityRun {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly activeSeconds: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Fold sessions into continuity runs (decision D6).
 *
 * A gap of at least {@link IDLE_BREAK_THRESHOLD_MINUTES} between one session
 * ending and the next starting closes the run; shorter gaps are bridged. The
 * threshold comes from the shared contract, never a local literal, so the
 * tracker, the API, the Care Engine and the tests cannot drift apart.
 */
export function foldIntoRuns(sessions: readonly StoredSession[]): ContinuityRun[] {
  const ordered = [...sessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const runs: ContinuityRun[] = [];

  for (const session of ordered) {
    const current = runs[runs.length - 1];

    if (current === undefined) {
      runs.push({
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        activeSeconds: session.activeSeconds,
      });
      continue;
    }

    const gapMs = session.startedAt.getTime() - current.endedAt.getTime();
    const bridges = gapMs < IDLE_BREAK_THRESHOLD_MINUTES * MS_PER_MINUTE;

    if (bridges) {
      runs[runs.length - 1] = {
        startedAt: current.startedAt,
        // Overlapping sessions must not shorten the run.
        endedAt:
          session.endedAt.getTime() > current.endedAt.getTime()
            ? session.endedAt
            : current.endedAt,
        activeSeconds: current.activeSeconds + session.activeSeconds,
      };
    } else {
      runs.push({
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        activeSeconds: session.activeSeconds,
      });
    }
  }

  return runs;
}

/**
 * Seconds to whole minutes, applied once at the end (decision D31).
 *
 * Rounding each session before summing would accumulate up to a minute of
 * error per session, which over a working day is material.
 */
function toMinutes(totalSeconds: number): number {
  return Math.floor(totalSeconds / 60);
}

function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

/**
 * Classify current activity (decision D27).
 *
 * An explicit heuristic tied to the extension's sync cadence, not a claim
 * about whether the person is really at their desk.
 */
function deriveCurrentActivity(
  now: Date,
  sessions: readonly StoredSession[],
): ActivityStatus {
  if (sessions.length === 0) {
    // No signal at all — a fresh install, not an idle user.
    return 'unknown';
  }

  const mostRecentEnd = Math.max(...sessions.map((s) => s.endedAt.getTime()));
  const elapsedMs = now.getTime() - mostRecentEnd;

  return elapsedMs < ACTIVITY_RECENCY_THRESHOLD_MINUTES * MS_PER_MINUTE
    ? 'active'
    : 'idle';
}

/**
 * The lunch window (decision D30).
 *
 * The shape is always present so the extension never has to branch on its
 * absence. Before routine learning has anything to say, the D8 fallback is
 * returned with `confidence: 0` and `source: "default"` — visibly a fallback,
 * never persisted, and never mistaken for a learned pattern.
 */
function deriveLunchWindow(
  now: Date,
  timeZone: IanaTimeZone,
  learned: LearnedLunchWindow | undefined,
): LunchWindow {
  if (learned !== undefined) {
    return {
      start: localTimeOnDay(now, timeZone, learned.start).toISOString(),
      end: localTimeOnDay(now, timeZone, learned.end).toISOString(),
      confidence: learned.confidence,
      source: 'learned',
    };
  }

  return {
    start: localTimeOnDay(now, timeZone, DEFAULT_LUNCH_WINDOW_START).toISOString(),
    end: localTimeOnDay(now, timeZone, DEFAULT_LUNCH_WINDOW_END).toISOString(),
    confidence: DEFAULT_LUNCH_WINDOW_CONFIDENCE,
    source: 'default',
  };
}

/**
 * Derive the user's current state.
 *
 * Pure and deterministic: identical inputs always produce identical output.
 */
export function deriveUserState(input: DeriveUserStateInput): UserState {
  const { now, timeZone, sessions } = input;

  const runs = foldIntoRuns(sessions);
  const lastRun = runs[runs.length - 1];

  // A run is still current only while the gap since it ended is under the
  // D6 threshold; otherwise the continuous stretch has ended and the counter
  // is zero, not stale.
  const currentRun =
    lastRun !== undefined &&
    now.getTime() - lastRun.endedAt.getTime() <
      IDLE_BREAK_THRESHOLD_MINUTES * MS_PER_MINUTE
      ? lastRun
      : undefined;

  const continuousWorkMinutes =
    currentRun === undefined ? 0 : toMinutes(currentRun.activeSeconds);

  // The run before the current one, or — when no run is current — the run the
  // user has just stopped working in.
  const previousRun = currentRun === undefined ? lastRun : runs[runs.length - 2];
  const lastBreakMinutesAgo =
    previousRun === undefined ? undefined : minutesBetween(previousRun.endedAt, now);

  // "Today" is the user's local day, never the UTC day (CLAUDE.md §28). A
  // session is attributed to the local day it started in.
  const dayStart = startOfLocalDay(now, timeZone);
  const totalWorkMinutesToday = toMinutes(
    sessions
      .filter((session) => session.startedAt.getTime() >= dayStart.getTime())
      .reduce((total, session) => total + session.activeSeconds, 0),
  );

  return {
    continuousWorkMinutes,
    totalWorkMinutesToday,
    ...(lastBreakMinutesAgo === undefined ? {} : { lastBreakMinutesAgo }),
    lunchWindow: deriveLunchWindow(now, timeZone, input.learnedLunchWindow),
    ...(input.lastLunchConfirmation === undefined
      ? {}
      : { lastLunchConfirmation: input.lastLunchConfirmation.toISOString() }),
    ...(input.lastInterventionAt === undefined
      ? {}
      : { lastInterventionAt: input.lastInterventionAt.toISOString() }),
    currentActivity: deriveCurrentActivity(now, sessions),
    paused: input.paused,
  };
}
