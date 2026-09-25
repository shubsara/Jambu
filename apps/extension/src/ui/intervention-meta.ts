/**
 * How each intervention type is presented (board screens 6 and 7).
 *
 * **Four types, because four is what the MVP has.** CLAUDE.md §2 lists lunch,
 * break, hydration and end of workday, and says not to expand the catalogue
 * without explicit approval.
 *
 * The board shows "Posture reminders" and omits Lunch. Posture is not an MVP
 * intervention type — there is no scoring rule, no message template and no
 * enum value for it, so a toggle would control nothing. Lunch is the Mom
 * Moment itself (§5), so leaving it out would hide the product's headline
 * behaviour behind no control at all. Both are raised for review rather than
 * resolved here; the visual treatment follows the board exactly.
 */
import type { InterventionType } from '@jambu/shared-types';

import type { TileTone } from './components.js';

export interface InterventionMeta {
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly tone: TileTone;
  /** The `user_preferences` flag this type is controlled by (docs/API.md §6). */
  readonly preferenceKey:
    'lunchEnabled' | 'breakEnabled' | 'hydrationEnabled' | 'endDayEnabled';
}

export const INTERVENTION_META: Readonly<Record<InterventionType, InterventionMeta>> = {
  lunch: {
    label: 'Lunch reminders',
    hint: 'A gentle check-in if you worked through it',
    icon: '🍱',
    tone: 'warm',
    preferenceKey: 'lunchEnabled',
  },
  break: {
    label: 'Break reminders',
    hint: 'Encourage regular short breaks',
    icon: '🍵',
    tone: 'green',
    preferenceKey: 'breakEnabled',
  },
  hydration: {
    label: 'Hydration reminders',
    hint: 'Gentle nudge to drink water',
    icon: '💧',
    tone: 'blue',
    preferenceKey: 'hydrationEnabled',
  },
  end_of_day: {
    label: 'End-of-day reminders',
    hint: 'Gentle wrap-up at the end of day',
    icon: '🌅',
    tone: 'sun',
    preferenceKey: 'endDayEnabled',
  },
};

/** Board order: the day's shape, from midday through to stopping. */
export const INTERVENTION_ORDER: readonly InterventionType[] = [
  'lunch',
  'break',
  'hydration',
  'end_of_day',
];
