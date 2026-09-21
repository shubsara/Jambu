/**
 * @jambu/care-engine
 *
 * The deterministic decision core (CLAUDE.md §13–§15, §17).
 *
 * The engine decides **whether** to intervene and **which type**. It never
 * decides wording: there is no message text and no persona awareness anywhere
 * in this package, which is what makes decision D10 true — adding a persona
 * cannot require an engine change.
 *
 * Purity (docs/ARCHITECTURE.md §3): no clock, no randomness, no database, no
 * network, no filesystem. `context.currentTime` is the only notion of "now",
 * and the ESLint rules in the repository root fail the build if any of that
 * is reached for.
 */
import type { CareContext, CareDecision, InterventionType } from '@jambu/shared-types';

import { SCORE_THRESHOLDS, TYPE_PRIORITY } from './config/scoring.js';
import { suppressionFor } from './cooldown.js';
import {
  qualifiesForBreak,
  qualifiesForEndOfDay,
  qualifiesForHydration,
  qualifiesForLunch,
  type Qualification,
} from './rules/index.js';
import { scoreFor, type ScoreBreakdown } from './scoring.js';

export {
  COOLDOWNS,
  RULE_THRESHOLDS,
  SCORE_THRESHOLDS,
  SCORING_WEIGHTS,
  TYPE_PRIORITY,
} from './config/scoring.js';
export { perTypeCooldownMinutes, suppressionFor } from './cooldown.js';
export { scoreFor } from './scoring.js';
export {
  qualifiesForBreak,
  qualifiesForEndOfDay,
  qualifiesForHydration,
  qualifiesForLunch,
} from './rules/index.js';
export type { Qualification } from './rules/index.js';
export type { ScoreBreakdown, ScoreSignal } from './scoring.js';

/** Exhaustive lookup — a new intervention type breaks the build here. */
function qualifierFor(type: InterventionType): (context: CareContext) => Qualification {
  switch (type) {
    case 'lunch':
      return qualifiesForLunch;
    case 'break':
      return qualifiesForBreak;
    case 'hydration':
      return qualifiesForHydration;
    case 'end_of_day':
      return qualifiesForEndOfDay;
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

interface Candidate {
  readonly type: InterventionType;
  readonly breakdown: ScoreBreakdown;
}

/** Render the arithmetic so a stored decision can explain itself (§13). */
function explain(breakdown: ScoreBreakdown): string {
  return breakdown.signals
    .map((signal) => `${signal.name} ${signal.points >= 0 ? '+' : ''}${signal.points}`)
    .join(', ');
}

/**
 * Decide whether to intervene.
 *
 * At most one decision is ever returned. Candidates must first qualify, then
 * survive suppression, then reach the §14 threshold; the highest score wins,
 * with ties broken by the fixed priority in docs/ARCHITECTURE.md §7.4.
 *
 * Deterministic: the same context always produces the same decision.
 */
export function decide(context: CareContext): CareDecision {
  const candidates: Candidate[] = [];
  const rejections: string[] = [];

  for (const type of TYPE_PRIORITY) {
    const qualification = qualifierFor(type)(context);
    if (!qualification.qualifies) {
      rejections.push(`${type}: ${qualification.reason}`);
      continue;
    }

    const suppression = suppressionFor(context, type);
    if (suppression !== null) {
      rejections.push(`${type}: ${suppression}`);
      continue;
    }

    candidates.push({ type, breakdown: scoreFor(context, type) });
  }

  if (candidates.length === 0) {
    return {
      shouldIntervene: false,
      interventionType: null,
      score: 0,
      reason: rejections.length > 0 ? rejections.join('; ') : 'nothing applies right now',
    };
  }

  // Highest score wins; TYPE_PRIORITY order breaks ties because the list is
  // already in priority order and the comparison is strict.
  const best = candidates.reduce((winner, candidate) =>
    candidate.breakdown.score > winner.breakdown.score ? candidate : winner,
  );

  const shouldIntervene = best.breakdown.score >= SCORE_THRESHOLDS.intervene;
  const band = shouldIntervene
    ? 'intervene'
    : best.breakdown.score >= SCORE_THRESHOLDS.monitor
      ? 'monitor'
      : 'below threshold';

  return {
    shouldIntervene,
    // Decision D38: the monitor band returns its score and reason but emits
    // no intervention, so near-misses can be tuned from real data later.
    interventionType: shouldIntervene ? best.type : null,
    score: best.breakdown.score,
    reason: `${best.type} (${band}): ${explain(best.breakdown)}`,
  };
}
