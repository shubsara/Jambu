/**
 * The analytics contract (CLAUDE.md §29, ARCHITECTURE.md §10, decision D113).
 *
 * This file carries the privacy assertion §10 asks for: it ranges over **all
 * twelve** event shapes, not a sample. A closed registry is what makes that
 * possible — an open payload type could only ever be spot-checked.
 */
import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_ENVELOPE_FIELDS,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_PAYLOAD_FIELDS,
  PREFERENCE_FIELD_NAMES,
  UNDERIVABLE_METRICS,
  findPrivacyViolations,
  type AnalyticsEvent,
} from './analytics.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-21T09:40:00Z';

/**
 * One well-formed payload per §29 event.
 *
 * Exhaustiveness is enforced by the type: `Record<AnalyticsEventName, ...>`
 * fails to compile if an event is added without a sample here, so the privacy
 * assertion below cannot silently stop covering something.
 */
const SAMPLES: Record<(typeof ANALYTICS_EVENT_NAMES)[number], AnalyticsEvent> = {
  onboarding_started: { event: 'onboarding_started', occurredAt: AT, userId: null },
  onboarding_completed: { event: 'onboarding_completed', occurredAt: AT, userId: USER },
  activity_session_started: {
    event: 'activity_session_started',
    occurredAt: AT,
    userId: USER,
  },
  activity_session_completed: {
    event: 'activity_session_completed',
    occurredAt: AT,
    userId: USER,
    activeSeconds: 1800,
  },
  intervention_shown: {
    event: 'intervention_shown',
    occurredAt: AT,
    userId: USER,
    interventionType: 'lunch',
    trigger: 'activity_sync',
    score: 75,
  },
  intervention_confirmed: {
    event: 'intervention_confirmed',
    occurredAt: AT,
    userId: USER,
    interventionType: 'lunch',
  },
  intervention_snoozed: {
    event: 'intervention_snoozed',
    occurredAt: AT,
    userId: USER,
    interventionType: 'break',
  },
  intervention_dismissed: {
    event: 'intervention_dismissed',
    occurredAt: AT,
    userId: USER,
    interventionType: 'hydration',
  },
  intervention_expired: {
    event: 'intervention_expired',
    occurredAt: AT,
    userId: USER,
    interventionType: 'end_of_day',
  },
  jambu_paused: {
    event: 'jambu_paused',
    occurredAt: AT,
    userId: USER,
    pauseDurationMinutes: 30,
  },
  jambu_resumed: { event: 'jambu_resumed', occurredAt: AT, userId: USER },
  settings_changed: {
    event: 'settings_changed',
    occurredAt: AT,
    userId: USER,
    changedFields: ['lunchEnabled', 'workStart'],
  },
};

describe('the registry is closed and complete (CLAUDE.md §29)', () => {
  it('names exactly the twelve §29 events', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      'onboarding_started',
      'onboarding_completed',
      'activity_session_started',
      'activity_session_completed',
      'intervention_shown',
      'intervention_confirmed',
      'intervention_snoozed',
      'intervention_dismissed',
      'intervention_expired',
      'jambu_paused',
      'jambu_resumed',
      'settings_changed',
    ]);
    expect(ANALYTICS_EVENT_NAMES).toHaveLength(12);
  });

  it('gives every event a defined typed payload', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(SAMPLES[name]).toBeDefined();
      expect(SAMPLES[name].event).toBe(name);
    }
    expect(Object.keys(SAMPLES)).toHaveLength(12);
  });

  it('introduces no uninstall event', () => {
    // §29 does not name one and P14 does not add one, so §30's "uninstall
    // rate" stays underivable rather than being faked from a proxy.
    expect(ANALYTICS_EVENT_NAMES).not.toContain('uninstall');
    expect(JSON.stringify(ANALYTICS_EVENT_NAMES)).not.toMatch(/uninstall/i);
  });

  it('permits only the six D113 event fields', () => {
    expect(ANALYTICS_PAYLOAD_FIELDS).toEqual([
      'interventionType',
      'trigger',
      'score',
      'activeSeconds',
      'pauseDurationMinutes',
      'changedFields',
    ]);
    expect(ANALYTICS_ENVELOPE_FIELDS).toEqual(['event', 'occurredAt', 'userId']);
  });
});

describe('privacy assertion over every payload (ARCHITECTURE.md §10)', () => {
  it.each(ANALYTICS_EVENT_NAMES)('%s carries nothing forbidden', (name) => {
    expect(findPrivacyViolations(SAMPLES[name])).toEqual([]);
  });

  it('every payload uses only contract fields', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      const allowed = new Set<string>([
        ...ANALYTICS_ENVELOPE_FIELDS,
        ...ANALYTICS_PAYLOAD_FIELDS,
      ]);
      for (const key of Object.keys(SAMPLES[name])) {
        expect({ name, key, allowed: allowed.has(key) }).toEqual({
          name,
          key,
          allowed: true,
        });
      }
    }
  });

  it('no payload mentions a domain, URL, page content, email or token', () => {
    const serialized = JSON.stringify(SAMPLES);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/[^\s"@]+@[^\s"@]+\.[^\s"@]+/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/\.(?:com|so|io|org|net|dev)\b/i);
  });

  it.each([
    [
      'a domain',
      { event: 'intervention_shown', occurredAt: AT, userId: USER, trigger: 'notion.so' },
    ],
    [
      'a URL',
      { event: 'jambu_paused', occurredAt: AT, userId: 'https://example.com/u/1' },
    ],
    [
      'an email',
      { event: 'onboarding_completed', occurredAt: AT, userId: 'someone@example.com' },
    ],
    [
      'a token',
      { event: 'jambu_resumed', occurredAt: AT, userId: 'eyJhbGciOiJIUzI1NiJ9xxxx' },
    ],
    [
      'an unknown field',
      { event: 'jambu_resumed', occurredAt: AT, userId: USER, pageTitle: 'x' },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(findPrivacyViolations(payload).length).toBeGreaterThan(0);
  });

  it('rejects an event name outside §29', () => {
    expect(
      findPrivacyViolations({ event: 'uninstalled', occurredAt: AT, userId: USER }),
    ).not.toEqual([]);
  });
});

describe('changedFields carries names, never values (decision D113)', () => {
  it('accepts only known preference keys', () => {
    expect(
      findPrivacyViolations({
        event: 'settings_changed',
        occurredAt: AT,
        userId: USER,
        changedFields: [...PREFERENCE_FIELD_NAMES],
      }),
    ).toEqual([]);
  });

  it.each([
    ['a time value', ['09:00']],
    ['a boolean value rendered as text', ['true']],
    ['a key=value pair', ['workStart=09:00']],
    ['a non-string', [42]],
  ])('rejects %s', (_label, changedFields) => {
    const problems = findPrivacyViolations({
      event: 'settings_changed',
      occurredAt: AT,
      userId: USER,
      changedFields,
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('no preference value can reach analytics through the allowlist', () => {
    // The allowlist is names only: none of its entries is a value, and a
    // value cannot be a member of it.
    for (const name of PREFERENCE_FIELD_NAMES) {
      expect(name).toMatch(/^[a-zA-Z]+$/);
      expect(name).not.toMatch(/[:=0-9]/);
    }
  });
});

describe('metric limitations are recorded, not invented', () => {
  it('lists what the twelve events cannot produce', () => {
    expect(UNDERIVABLE_METRICS).toContain('uninstall rate');
    expect(UNDERIVABLE_METRICS).toContain('meaningful intervention engagement');
    expect(UNDERIVABLE_METRICS).toContain('Day-1 retention');
    expect(UNDERIVABLE_METRICS).toContain('Day-7 retention');
    expect(UNDERIVABLE_METRICS).toContain('pause rate');
  });

  it('carries no user-local timezone data (P14 limitation)', () => {
    expect(ANALYTICS_PAYLOAD_FIELDS).not.toContain('timezone');
    expect(JSON.stringify(SAMPLES)).not.toMatch(/Asia\/|Europe\/|America\//);
  });

  it('onboarding_started is allowed to have no user', () => {
    // D114: the account does not exist when the page mounts. A null here is
    // correct data, and D113 forbids substituting an anonymous id.
    expect(SAMPLES.onboarding_started.userId).toBeNull();
    expect(findPrivacyViolations(SAMPLES.onboarding_started)).toEqual([]);
  });
});
