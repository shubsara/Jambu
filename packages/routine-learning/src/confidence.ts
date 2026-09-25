/**
 * Confidence from sample count (CLAUDE.md §16, decision D81).
 *
 * §16 gives the tiers but no numbers; the values below were surfaced and
 * approved as D81. They matter more than they look: confidence above zero is
 * what earns the Care Engine's `+20` historical-pattern term, which is the
 * difference between a break reminder that can fire and one that never does.
 */
import { MIN_OBSERVATIONS_FOR_PERSONALIZATION } from '@jambu/shared-types';

export type ConfidenceTier = 'insufficient' | 'low' | 'medium' | 'high';

/** Decision D81. Zero for `insufficient`, so a default can never pass as learned. */
export const CONFIDENCE_BY_TIER: Readonly<Record<ConfidenceTier, number>> = {
  insufficient: 0,
  low: 0.4,
  medium: 0.65,
  high: 0.85,
};

/** CLAUDE.md §16 tier boundaries. */
export const TIER_THRESHOLDS = {
  /** Below this, Jambu uses generic default behaviour and does not personalize. */
  low: MIN_OBSERVATIONS_FOR_PERSONALIZATION,
  medium: 8,
  high: 15,
} as const;

export function tierFor(sampleCount: number): ConfidenceTier {
  if (sampleCount < TIER_THRESHOLDS.low) {
    return 'insufficient';
  }
  if (sampleCount < TIER_THRESHOLDS.medium) {
    return 'low';
  }
  if (sampleCount < TIER_THRESHOLDS.high) {
    return 'medium';
  }
  return 'high';
}

export function confidenceFor(sampleCount: number): number {
  return CONFIDENCE_BY_TIER[tierFor(sampleCount)];
}

/**
 * Whether there is enough evidence to personalize at all.
 *
 * CLAUDE.md §16: "Do not over-personalize based on insufficient data." Below
 * the threshold the caller keeps the D8 default and reports `source: default`.
 */
export function hasEnoughObservations(sampleCount: number): boolean {
  return sampleCount >= TIER_THRESHOLDS.low;
}
