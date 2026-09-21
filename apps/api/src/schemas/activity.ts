/**
 * Activity ingest schema (docs/API.md §4).
 *
 * Bounds come from `@jambu/shared-types` so the extension can chunk its buffer
 * to the same numbers (decision D25). Every out-of-range value is rejected
 * rather than clamped.
 */
import {
  MAX_ACTIVE_SECONDS_PER_SESSION,
  MAX_ACTIVITY_SESSIONS_PER_BATCH,
  MAX_CLOCK_SKEW_MINUTES,
  MAX_SESSION_AGE_DAYS,
} from '@jambu/shared-types';
import { z } from 'zod';

import { normalizeDomain } from '../services/domain.js';

const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'A valid ISO 8601 timestamp is required.',
  );

/**
 * The domain field.
 *
 * Decision D23: a value carrying a URL, path, query or fragment is refused
 * with the standard validation envelope. The rejection reason is a fixed code
 * and never repeats the submitted value, so a leaked URL cannot reach a log
 * line or an error body through the error message.
 */
const domain = z.string().transform((value, ctx) => {
  const result = normalizeDomain(value);
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `domain must be a bare hostname (${result.reason})`,
    });
    return z.NEVER;
  }
  return result.domain;
});

const sessionSchema = z
  .object({
    clientSessionId: z.string().uuid('clientSessionId must be a UUID.'),
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    activeSeconds: z
      .number()
      .int()
      .min(0, 'activeSeconds must not be negative.')
      .max(MAX_ACTIVE_SECONDS_PER_SESSION, 'activeSeconds exceeds one day.'),
    domain: domain.optional(),
  })
  .strict()
  .superRefine((session, ctx) => {
    const started = Date.parse(session.startedAt);
    const ended = Date.parse(session.endedAt);

    if (ended < started) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'endedAt must not precede startedAt.',
      });
    }

    const now = Date.now();
    if (started > now + MAX_CLOCK_SKEW_MINUTES * 60_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'startedAt is too far in the future.',
      });
    }

    if (started < now - MAX_SESSION_AGE_DAYS * 24 * 60 * 60_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'startedAt is older than the accepted window.',
      });
    }

    // A session cannot contain more active time than it spans.
    const spanSeconds = Math.floor((ended - started) / 1000);
    if (session.activeSeconds > spanSeconds + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeSeconds'],
        message: 'activeSeconds exceeds the session duration.',
      });
    }
  });

export const activityBatchSchema = z
  .object({
    sessions: z
      .array(sessionSchema)
      .min(1, 'At least one session is required.')
      .max(MAX_ACTIVITY_SESSIONS_PER_BATCH, 'Too many sessions in one batch.'),
  })
  .strict();

export type ActivityBatch = z.infer<typeof activityBatchSchema>;
export type ValidatedSession = ActivityBatch['sessions'][number];
