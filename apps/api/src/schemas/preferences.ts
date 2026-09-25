/**
 * Preferences request schemas (decision D16, docs/API.md §6).
 *
 * `PUT` takes a partial object, so every field is optional — but the object is
 * `.strict()`, which is what stops a client inventing a field the API would
 * silently ignore.
 */
import { isKnownPersona } from '@jambu/message-templates';
import { z } from 'zod';

import { timezone } from './auth.js';

/** `HH:mm`, 24-hour, in the user's local time (shared-types `TimeOfDay`). */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time must look like 09:30.');

/**
 * Decision D10 — only personas the message registry knows about are accepted.
 * An unknown value is a validation failure, never something stored and
 * discovered later when a care card fails to render.
 */
const persona = z
  .string()
  .trim()
  .refine(isKnownPersona, 'That persona is not available.');

export const updatePreferencesSchema = z
  .object({
    // Work hours are not collected during onboarding (D88), but they remain
    // part of the documented §6 contract and P13's settings surface will need
    // them. The onboarding-side guard is `OnboardingSubmission`, which has no
    // field for them at all.
    workStart: timeOfDay.optional(),
    workEnd: timeOfDay.optional(),
    lunchEnabled: z.boolean().optional(),
    breakEnabled: z.boolean().optional(),
    hydrationEnabled: z.boolean().optional(),
    endDayEnabled: z.boolean().optional(),
    persona: persona.optional(),
    /** Decision D90 — the only way to change `users.timezone` after signup. */
    timezone: timezone.optional(),
    /**
     * Resolution A2 — completion is explicit and idempotent. `false` is
     * rejected rather than ignored: onboarding cannot be un-completed here,
     * and silently accepting `false` would imply otherwise.
     */
    onboardingCompleted: z
      .literal(true, { message: 'Onboarding can only be marked complete.' })
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Send at least one preference to update.',
  );

export type UpdatePreferencesRequest = z.infer<typeof updatePreferencesSchema>;
