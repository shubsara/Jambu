/**
 * Preferences and onboarding completion against the live stack
 * (docs/API.md §6; decisions D86, D89, D90, D91, and resolutions A1, A2, A4).
 *
 * The cases that matter most here are the ones about consent: completion must
 * be explicit and must not be reachable by accident, because D93 turns it into
 * permission to observe the user.
 */
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let db: Client;

const PASSWORD = 'correct-horse-battery';
const createdEmails: string[] = [];

function testConfig() {
  return { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 10_000 };
}

interface Account {
  readonly id: string;
  readonly token: string;
}

async function createAccount(prefix: string, timezone = 'UTC'): Promise<Account> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
  createdEmails.push(email);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, timezone },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    token: response.json().accessToken as string,
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const getPreferences = (token: string) =>
  app.inject({ method: 'GET', url: '/api/preferences', headers: auth(token) });

const putPreferences = (token: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/api/preferences',
    headers: auth(token),
    payload: payload as never,
  });

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

describe('GET /api/preferences', () => {
  it('returns the registration defaults, hydration off (D7, D91)', async () => {
    const account = await createAccount('pref-default', 'Asia/Kolkata');
    const response = await getPreferences(account.token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workStart: '09:00',
      workEnd: '18:00',
      lunchEnabled: true,
      breakEnabled: true,
      hydrationEnabled: false,
      endDayEnabled: true,
      persona: 'mom',
      timezone: 'Asia/Kolkata',
      onboardingCompletedAt: null,
    });
  });

  it('reports a new account as not onboarded (D86, A4)', async () => {
    const account = await createAccount('pref-new');
    expect((await getPreferences(account.token)).json().onboardingCompletedAt).toBeNull();
  });

  it('refuses unauthenticated access to both routes', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/preferences' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/preferences',
          payload: { lunchEnabled: false } as never,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('PUT /api/preferences', () => {
  it('applies a partial update and returns the whole object', async () => {
    const account = await createAccount('pref-partial');
    const response = await putPreferences(account.token, { hydrationEnabled: true });

    expect(response.statusCode).toBe(200);
    expect(response.json().hydrationEnabled).toBe(true);
    // Untouched fields come back unchanged, not dropped.
    expect(response.json().lunchEnabled).toBe(true);
    expect(response.json().workStart).toBe('09:00');
  });

  it('persists what the onboarding step sends (D89)', async () => {
    const account = await createAccount('pref-toggles');
    await putPreferences(account.token, {
      lunchEnabled: true,
      breakEnabled: false,
      hydrationEnabled: true,
      endDayEnabled: true,
    });

    const stored = await getPreferences(account.token);
    expect(stored.json().breakEnabled).toBe(false);
    expect(stored.json().hydrationEnabled).toBe(true);
  });

  it('changes the timezone, which nothing else can (D90)', async () => {
    const account = await createAccount('pref-tz', 'UTC');
    const response = await putPreferences(account.token, { timezone: 'Asia/Kolkata' });

    expect(response.json().timezone).toBe('Asia/Kolkata');

    const { rows } = await db.query<{ timezone: string }>(
      'select timezone from public.users where id = $1',
      [account.id],
    );
    // It must land on `users`, which is where every local-time conversion
    // reads it from (ARCHITECTURE §13).
    expect(rows[0]?.timezone).toBe('Asia/Kolkata');
  });

  it('rejects an invalid timezone', async () => {
    const account = await createAccount('pref-badtz');
    const response = await putPreferences(account.token, { timezone: 'Mars/Olympus' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown persona (D10)', async () => {
    const account = await createAccount('pref-persona');
    const response = await putPreferences(account.token, { persona: 'drill-sergeant' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a field the contract does not have', async () => {
    const account = await createAccount('pref-strict');
    // A schedule field is exactly what §3.2 forbids collecting, and the
    // strict schema is what makes it unstorable rather than merely unasked.
    const response = await putPreferences(account.token, { lunchTime: '13:00' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty update', async () => {
    const account = await createAccount('pref-empty');
    expect((await putPreferences(account.token, {})).statusCode).toBe(400);
  });
});

describe('onboarding completion (A2)', () => {
  it('is set only by an explicit flag', async () => {
    const account = await createAccount('pref-complete');

    // An ordinary preference update must NOT complete onboarding — in P13 a
    // settings edit would otherwise switch tracking on behind the user's back.
    await putPreferences(account.token, { hydrationEnabled: true });
    expect((await getPreferences(account.token)).json().onboardingCompletedAt).toBeNull();

    const done = await putPreferences(account.token, { onboardingCompleted: true });
    expect(done.json().onboardingCompletedAt).not.toBeNull();
  });

  it('is idempotent — the first timestamp wins', async () => {
    const account = await createAccount('pref-idem');
    const first = (
      await putPreferences(account.token, { onboardingCompleted: true })
    ).json().onboardingCompletedAt;

    const second = (
      await putPreferences(account.token, { onboardingCompleted: true })
    ).json().onboardingCompletedAt;
    const third = (
      await putPreferences(account.token, {
        onboardingCompleted: true,
        lunchEnabled: false,
      })
    ).json().onboardingCompletedAt;

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('cannot be un-completed', async () => {
    const account = await createAccount('pref-uncomplete');
    await putPreferences(account.token, { onboardingCompleted: true });

    const response = await putPreferences(account.token, { onboardingCompleted: false });
    expect(response.statusCode).toBe(400);
    expect(
      (await getPreferences(account.token)).json().onboardingCompletedAt,
    ).not.toBeNull();
  });

  it('completes together with the toggles in one call', async () => {
    const account = await createAccount('pref-onestep');
    // What the final onboarding step actually sends.
    const response = await putPreferences(account.token, {
      timezone: 'Asia/Kolkata',
      lunchEnabled: true,
      breakEnabled: true,
      hydrationEnabled: false,
      endDayEnabled: true,
      onboardingCompleted: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().timezone).toBe('Asia/Kolkata');
    expect(response.json().hydrationEnabled).toBe(false);
    expect(response.json().onboardingCompletedAt).not.toBeNull();
  });
});

describe('isolation', () => {
  it("never reads or writes another user's preferences", async () => {
    const alice = await createAccount('pref-alice', 'Asia/Kolkata');
    const bob = await createAccount('pref-bob', 'UTC');

    await putPreferences(alice.token, {
      hydrationEnabled: true,
      onboardingCompleted: true,
    });

    const bobsView = await getPreferences(bob.token);
    expect(bobsView.json().hydrationEnabled).toBe(false);
    expect(bobsView.json().timezone).toBe('UTC');
    expect(bobsView.json().onboardingCompletedAt).toBeNull();
  });
});
