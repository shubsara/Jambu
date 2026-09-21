/**
 * Intervention request schemas (docs/API.md §8).
 */
import { INTERVENTION_RESPONSE_TYPES } from '@jambu/shared-types';
import { z } from 'zod';

/**
 * Responses a client may submit.
 *
 * Decision D46: `expired` is deliberately excluded. It is an outcome of the
 * expiry sweep, not something a user can claim, so a client submitting it gets
 * the ordinary validation error.
 */
const CLIENT_SUBMITTABLE = INTERVENTION_RESPONSE_TYPES.filter(
  (value) => value !== 'expired',
) as ['confirmed', 'not_yet', 'snoozed', 'dismissed'];

export const interventionResponseSchema = z
  .object({
    response: z.enum(CLIENT_SUBMITTABLE),
    respondedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const interventionIdSchema = z
  .object({ id: z.string().uuid('An intervention id is required.') })
  .strict();

export type InterventionResponseRequest = z.infer<typeof interventionResponseSchema>;
