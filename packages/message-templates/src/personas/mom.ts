/**
 * The `mom` persona — the only persona in the MVP (decision D10).
 *
 * Every message below is reproduced verbatim from CLAUDE.md §20, and
 * `mom.test.ts` parses CLAUDE.md to prove it still is.
 *
 * Tone rules these messages exist to satisfy:
 *   §3.3 — warm, familiar and non-judgmental, never "Reminder: it is time for
 *          lunch."
 *   §40  — Jambu asks questions. It never makes authoritative health claims
 *          such as "You are dehydrated" or "Your body needs...". It is a care
 *          companion, not a medical authority.
 */

import type { Persona } from '../persona.js';

export const MOM_PERSONA: Persona = {
  id: 'mom',
  displayName: 'Mom',
  signature: '— Mom ❤️',
  avatarAssetId: 'avatar-mom',
  tone: {
    warmth: 'high',
    formality: 'casual',
    description: 'Warm, familiar and non-judgmental. Checks in; never instructs.',
  },
  messages: {
    // CLAUDE.md §20 — lunchMessages
    lunch: [
      'Hey! Have you taken your lunch? ❤️',
      'Just checking in... have you had lunch yet?',
      "Hey, don't forget to eat something. ❤️",
      "You've been working for a while. Have you eaten?",
    ],
    // CLAUDE.md §20 — breakMessages
    break: [
      "You've been working for a while. How about a little break?",
      'Hey, stretch your legs for a minute, okay? ❤️',
      'A tiny break might do you good.',
    ],
    // CLAUDE.md §20 — hydrationMessages
    hydration: ['Hey! Have you had some water? 💧', 'Quick check-in: water break?'],
    // CLAUDE.md §20 — endOfDayMessages
    end_of_day: [
      "You've done enough for today. Want to call it a day? ❤️",
      "Okay, that's enough work for today. Take some time for yourself.",
    ],
  },
};
