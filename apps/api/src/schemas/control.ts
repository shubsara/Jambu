/**
 * Pause, snooze and deletion request schemas (decision D16, docs/API.md §9-11).
 *
 * The confirmation literals below are the only thing standing between a
 * mis-click and an irreversible deletion, so they are matched exactly — no
 * trimming, no case folding, no "close enough" (decision D106).
 */
import { INTERVENTION_TYPES } from '@jambu/shared-types';
import { z } from 'zod';

/** An ISO 8601 instant. `.datetime()` rejects a bare date or a local time. */
const instant = z.string().datetime({ offset: true });

export const pauseRequestSchema = z
  .object({
    /** Omit to pause indefinitely (docs/API.md §9). */
    until: instant.optional(),
  })
  .strict();

export const snoozeRequestSchema = z
  .object({
    type: z.enum(INTERVENTION_TYPES),
    until: instant,
  })
  .strict();

export const snoozeTypeParamSchema = z
  .object({ type: z.enum(INTERVENTION_TYPES) })
  .strict();

export const deletionRequestIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Decision D106 — the user types the phrase.
 *
 * `z.literal` gives an exact match: `"delete_activity"`, `" DELETE_ACTIVITY "`
 * and `"DELETE ACTIVITY"` are all refused. That is the point — a confirmation
 * that accepts near misses is not a confirmation.
 */
export const confirmActivityDeletionSchema = z
  .object({
    confirm: z.literal('DELETE_ACTIVITY', {
      message: 'Type DELETE_ACTIVITY exactly to confirm.',
    }),
  })
  .strict();

export const confirmAccountDeletionSchema = z
  .object({
    confirm: z.literal('DELETE_ACCOUNT', {
      message: 'Type DELETE_ACCOUNT exactly to confirm.',
    }),
  })
  .strict();

export type PauseRequest = z.infer<typeof pauseRequestSchema>;
export type SnoozeRequest = z.infer<typeof snoozeRequestSchema>;
