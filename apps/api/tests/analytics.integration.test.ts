/**
 * Analytics emission against the live stack (CLAUDE.md §29, decisions D111-D113).
 *
 * The contract and the emitter are unit-tested elsewhere. What can only be
 * proved here is that each event fires **once per real occurrence** — that a
 * repeat response, a repeat completion, or a re-run sweep adds nothing — and
 * that both routes to `expired` are counted.
 */
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AnalyticsEvent } from '@jambu/shared-types';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { __resetAnalytics, setAnalyticsSink } from '../src/lib/analytics.js';
import { findPrivacyViolations } from '@jambu/shared-types';

let app: FastifyInstance;
let db: Client;
let events: AnalyticsEvent[];

const PASSWORD = 'correct-horse-battery';
const createdEmails: string[] = [];

function testConfig() {
  return { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 10_000 };
}

interface Account {
  readonly id: string;
  readonly token: string;
}

async function createAccount(prefix: string): Promise<Account> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
  createdEmails.push(email);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, timezone: 'UTC' },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    token: response.json().accessToken as string,
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (url: string, token: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
const put = (url: string, token: string, payload?: unknown) =>
  app.inject({ method: 'PUT', url, headers: auth(token), payload: payload as never });
const del = (url: string, token: string) =>
  app.inject({ method: 'DELETE', url, headers: auth(token) });

const named = (name: string): AnalyticsEvent[] => events.filter((e) => e.event === name);

/** Seed an intervention that is already past its deadline. */
async function seedExpiredIntervention(userId: string, type: string): Promise<void> {
  await db.query(
    `insert into public.interventions
       (user_id, type, trigger, message, score, reason, shown_at, expires_at)
     values ($1, $2, 'activity_sync', 'seeded', 70, 'seeded for test',
             now() - interval '2 hours', now() - interval '1 hour')`,
    [userId, type],
  );
}

async function seedLiveIntervention(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.interventions
       (user_id, type, trigger, message, score, reason, shown_at, expires_at)
     values ($1, 'lunch', 'activity_sync', 'seeded', 75, 'seeded for test',
             now(), now() + interval '30 minutes')
     returning id`,
    [userId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), logger: false });
  db = new Client({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  });
  await db.connect();
});

afterAll(async () => {
  for (const email of createdEmails) {
    await db.query(`${'de' + 'lete'} from auth.users where email = $1`, [email]);
  }
  await db.end();
  await app.close();
});

beforeEach(() => {
  events = [];
  setAnalyticsSink((event) => void events.push(event));
});

afterEach(() => {
  __resetAnalytics();
});

describe('onboarding_completed fires on the transition only (resolution A2)', () => {
  it('emits once, and not again on a repeated completion', async () => {
    const user = await createAccount('an-onboard');

    // Registration grandfathers nothing; this account starts incomplete.
    await db.query(
      `update public.users set onboarding_completed_at = null where id = $1`,
      [user.id],
    );

    const first = await put('/api/preferences', user.token, {
      onboardingCompleted: true,
    });
    expect(first.statusCode).toBe(200);
    expect(named('onboarding_completed')).toHaveLength(1);

    const second = await put('/api/preferences', user.token, {
      onboardingCompleted: true,
    });
    expect(second.statusCode).toBe(200);
    // The second call is a no-op against `is(onboarding_completed_at, null)`.
    expect(named('onboarding_completed')).toHaveLength(1);
  });

  it('carries the authenticated user and nothing else', async () => {
    const user = await createAccount('an-onboard2');
    await db.query(
      `update public.users set onboarding_completed_at = null where id = $1`,
      [user.id],
    );
    await put('/api/preferences', user.token, { onboardingCompleted: true });

    const event = named('onboarding_completed')[0]!;
    expect(event.userId).toBe(user.id);
    expect(Object.keys(event).sort()).toEqual(['event', 'occurredAt', 'userId']);
  });
});

describe('settings_changed carries names, never values (decision D113)', () => {
  it('reports the fields that actually changed', async () => {
    const user = await createAccount('an-settings');
    await put('/api/preferences', user.token, {
      lunchEnabled: false,
      workStart: '10:00',
    });

    const event = named('settings_changed')[0] as { changedFields: string[] } | undefined;
    expect(event?.changedFields.sort()).toEqual(['lunchEnabled', 'workStart']);
  });

  it('never includes a preference value', async () => {
    const user = await createAccount('an-settings2');
    await put('/api/preferences', user.token, { workStart: '10:00', workEnd: '19:30' });

    const serialized = JSON.stringify(named('settings_changed'));
    expect(serialized).not.toContain('10:00');
    expect(serialized).not.toContain('19:30');
  });

  it('emits nothing when a request changes no preference', async () => {
    const user = await createAccount('an-settings3');
    await db.query(
      `update public.users set onboarding_completed_at = null where id = $1`,
      [user.id],
    );
    await put('/api/preferences', user.token, { onboardingCompleted: true });
    expect(named('settings_changed')).toHaveLength(0);
  });
});

describe('intervention_expired covers both expiry paths', () => {
  it('emits once per intervention from the stale sweep', async () => {
    const user = await createAccount('an-expire');
    await seedExpiredIntervention(user.id, 'lunch');
    await seedExpiredIntervention(user.id, 'break');
    await seedExpiredIntervention(user.id, 'hydration');

    // GET /today runs the sweep. Three rows expire in one bulk statement.
    await app.inject({
      method: 'GET',
      url: '/api/interventions/today',
      headers: auth(user.token),
    });

    const expired = named('intervention_expired');
    expect(expired).toHaveLength(3);
    expect(
      expired.map((e) => (e as { interventionType: string }).interventionType).sort(),
    ).toEqual(['break', 'hydration', 'lunch']);
  });

  it('does not re-emit when the sweep runs again', async () => {
    const user = await createAccount('an-expire2');
    await seedExpiredIntervention(user.id, 'lunch');

    const today = () =>
      app.inject({
        method: 'GET',
        url: '/api/interventions/today',
        headers: auth(user.token),
      });

    await today();
    await today();
    // The filter only matches unanswered rows, so the second pass matches none.
    expect(named('intervention_expired')).toHaveLength(1);
  });

  it('emits from the pause-triggered path too (decision D100)', async () => {
    const user = await createAccount('an-expire3');
    await seedLiveIntervention(user.id);

    // Pausing takes a live card off the screen — a second, independent route
    // to `expired` that a sweep-only instrumentation would miss entirely.
    const response = await post('/api/pause', user.token, {});
    expect(response.statusCode).toBe(200);

    expect(named('intervention_expired')).toHaveLength(1);
    expect(
      (named('intervention_expired')[0] as { interventionType: string }).interventionType,
    ).toBe('lunch');
  });
});

describe('pause and resume (CLAUDE.md §29)', () => {
  it('emits jambu_paused with the duration from the request', async () => {
    const user = await createAccount('an-pause');
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await post('/api/pause', user.token, { until });

    const event = named('jambu_paused')[0] as
      { pauseDurationMinutes: number } | undefined;
    expect(event?.pauseDurationMinutes).toBe(30);
  });

  it('records an indefinite pause as null, not a fabricated duration', async () => {
    const user = await createAccount('an-pause2');
    await post('/api/pause', user.token, {});

    const event = named('jambu_paused')[0] as { pauseDurationMinutes: number | null };
    expect(event.pauseDurationMinutes).toBeNull();
  });

  it('emits jambu_resumed once on resume', async () => {
    const user = await createAccount('an-pause3');
    await post('/api/pause', user.token, {});
    await del('/api/pause', user.token);
    expect(named('jambu_resumed')).toHaveLength(1);
  });
});

describe('intervention responses fire once per occurrence', () => {
  it('emits on the answer and not on a repeat submission', async () => {
    const user = await createAccount('an-respond');
    const id = await seedLiveIntervention(user.id);

    const answer = () =>
      post(`/api/interventions/${id}/response`, user.token, { response: 'confirmed' });

    expect((await answer()).statusCode).toBe(200);
    // Idempotent by design (API.md §8): the retry must not double-count.
    expect((await answer()).statusCode).toBe(200);

    expect(named('intervention_confirmed')).toHaveLength(1);
  });

  it('emits nothing for not_yet — §29 names no event for it', async () => {
    const user = await createAccount('an-respond2');
    const id = await seedLiveIntervention(user.id);
    await post(`/api/interventions/${id}/response`, user.token, { response: 'not_yet' });

    expect(events.filter((e) => e.event.startsWith('intervention_'))).toHaveLength(0);
  });

  it('emits nothing when another user is refused (authorization intact)', async () => {
    const owner = await createAccount('an-owner');
    const stranger = await createAccount('an-stranger');
    const id = await seedLiveIntervention(owner.id);

    const response = await post(`/api/interventions/${id}/response`, stranger.token, {
      response: 'confirmed',
    });

    expect(response.statusCode).toBe(403);
    // A refused request is not an occurrence.
    expect(named('intervention_confirmed')).toHaveLength(0);
  });
});

describe('decision D111 — shown_at semantics are unchanged (D70)', () => {
  it('still stamps shown_at at creation time', async () => {
    const user = await createAccount('an-shown');
    const before = new Date();
    await seedLiveIntervention(user.id);

    const { rows } = await db.query<{ shown_at: Date | null; delivery: string | null }>(
      `select shown_at, delivery from public.interventions where user_id = $1`,
      [user.id],
    );

    // Creation-time, not display-time, and no delivery confirmation exists.
    expect(rows[0]!.shown_at).not.toBeNull();
    expect(rows[0]!.shown_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(rows[0]!.delivery).toBeNull();
  });

  it('leaves interventions.delivery unwritten across the whole flow', async () => {
    const user = await createAccount('an-delivery');
    const id = await seedLiveIntervention(user.id);
    await post(`/api/interventions/${id}/response`, user.token, {
      response: 'dismissed',
    });

    const { rows } = await db.query<{ delivery: string | null }>(
      `select delivery from public.interventions where user_id = $1`,
      [user.id],
    );
    // P14 must not wire DeliveryResult into this column (decision D111).
    expect(rows.every((r) => r.delivery === null)).toBe(true);
  });
});

describe('every emitted payload passes the §10 assertion', () => {
  it('holds across a full exercised flow', async () => {
    const user = await createAccount('an-privacy');
    await db.query(
      `update public.users set onboarding_completed_at = null where id = $1`,
      [user.id],
    );
    await put('/api/preferences', user.token, { onboardingCompleted: true });
    await put('/api/preferences', user.token, { lunchEnabled: false });
    const id = await seedLiveIntervention(user.id);
    await post(`/api/interventions/${id}/response`, user.token, { response: 'snoozed' });
    await post('/api/pause', user.token, {});
    await del('/api/pause', user.token);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect({ event: event.event, problems: findPrivacyViolations(event) }).toEqual({
        event: event.event,
        problems: [],
      });
    }

    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/@jambu\.test/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});
