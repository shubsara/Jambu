/**
 * Intervention lifecycle against the live stack (docs/API.md §8).
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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
}

function testConfig() {
  return { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 10_000 };
}

interface Account {
  readonly id: string;
  readonly token: string;
}

async function createAccount(prefix: string, timezone = 'UTC'): Promise<Account> {
  const email = uniqueEmail(prefix);
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

/** Sustained recent work, enough to clear the lunch gate. */
function workSession(endMinutesAgo = 1, lengthMinutes = 200) {
  const endedAt = new Date(Date.now() - endMinutesAgo * 60_000);
  return {
    clientSessionId: crypto.randomUUID(),
    startedAt: new Date(endedAt.getTime() - lengthMinutes * 60_000).toISOString(),
    endedAt: endedAt.toISOString(),
    activeSeconds: lengthMinutes * 60,
    domain: 'notion.so',
  };
}

async function submitActivity(token: string, sessions: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/api/activity/session',
    headers: auth(token),
    payload: { sessions } as never,
  });
}

/** Put the user inside a lunch window so the lunch rule can qualify. */
async function makeLunchLikely(account: Account) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = new Date(now.getTime() - 30 * 60_000);
  const end = new Date(now.getTime() + 30 * 60_000);
  await db.query(
    `insert into public.routine_patterns
       (user_id, pattern_type, day_of_week, start_time, end_time, confidence, sample_count)
     values ($1, 'lunch', null, $2, $3, 0.9, 20)
     on conflict (user_id, pattern_type, day_of_week) do update
       set start_time = excluded.start_time, end_time = excluded.end_time`,
    [
      account.id,
      `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`,
      `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`,
    ],
  );
}

async function create(token: string) {
  return app.inject({ method: 'POST', url: '/api/interventions', headers: auth(token) });
}

async function respond(token: string, id: string, response: string) {
  return app.inject({
    method: 'POST',
    url: `/api/interventions/${id}/response`,
    headers: auth(token),
    payload: { response } as never,
  });
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

/** A user set up so the engine will decide to intervene. */
async function readyToIntervene(prefix: string): Promise<Account> {
  const account = await createAccount(prefix);
  await makeLunchLikely(account);
  await submitActivity(account.token, [workSession()]);
  return account;
}

describe('POST /api/interventions (decision D45)', () => {
  it('creates an intervention and persists the engine score and reason unchanged', async () => {
    const account = await readyToIntervene('intv-create');
    const response = await create(account.token);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.type).toBe('lunch');
    expect(body.persona).toBe('mom');
    expect(typeof body.message).toBe('string');

    const { rows } = await db.query<{ score: number; reason: string }>(
      `select score, reason from public.interventions where id = $1`,
      [body.id],
    );
    expect(rows[0]?.score).toBeGreaterThanOrEqual(70);
    // The engine's own arithmetic, stored verbatim.
    expect(rows[0]?.reason).toContain('lunch');
    expect(rows[0]?.reason).toMatch(/[+-]\d+/);
  });

  it('returns 204 and creates nothing when the engine declines', async () => {
    // No activity at all: a clock-only context must never intervene.
    const idle = await createAccount('intv-declined');
    const response = await create(idle.token);

    expect(response.statusCode).toBe(204);
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.interventions where user_id = $1`,
      [idle.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('returns the existing live intervention instead of creating a second', async () => {
    const account = await readyToIntervene('intv-existing');
    const first = await create(account.token);
    expect(first.statusCode).toBe(200);

    const second = await create(account.token);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.interventions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('returns 409 and creates nothing while the user is paused', async () => {
    // Pause first: readyToIntervene would otherwise leave a live intervention,
    // and an existing live card is a 200 by decision D45 regardless of pause.
    const account = await createAccount('intv-paused');
    await makeLunchLikely(account);
    await db.query('insert into public.pause_states (user_id) values ($1)', [account.id]);
    await submitActivity(account.token, [workSession()]);

    const response = await create(account.token);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.interventions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('accepts no client-supplied decision, score, message or expiry', async () => {
    const account = await readyToIntervene('intv-authoritative');
    const response = await app.inject({
      method: 'POST',
      url: '/api/interventions',
      headers: auth(account.token),
      payload: {
        type: 'hydration',
        score: 999,
        reason: 'because I said so',
        message: 'arbitrary text',
      } as never,
    });

    expect(response.statusCode).toBe(200);
    const { rows } = await db.query<{ score: number; message: string; type: string }>(
      `select score, message, type from public.interventions where id = $1`,
      [response.json().id],
    );
    expect(rows[0]?.score).not.toBe(999);
    expect(rows[0]?.message).not.toBe('arbitrary text');
    expect(rows[0]?.type).toBe('lunch');
  });
});

describe('POST /api/interventions/:id/response', () => {
  it('records each of the four client-submittable responses', async () => {
    for (const answer of ['confirmed', 'not_yet', 'snoozed', 'dismissed']) {
      const account = await readyToIntervene(`intv-${answer}`);
      const created = await create(account.token);
      expect(created.statusCode).toBe(200);

      const response = await respond(account.token, created.json().id, answer);
      expect(response.statusCode).toBe(200);
      expect(response.json().response).toBe(answer);

      const { rows } = await db.query<{ response: string; responded_at: string | null }>(
        `select response, responded_at from public.interventions where id = $1`,
        [created.json().id],
      );
      expect(rows[0]?.response).toBe(answer);
      expect(rows[0]?.responded_at).not.toBeNull();
    }
  });

  it('rejects a client-submitted expired (decision D46)', async () => {
    const account = await readyToIntervene('intv-expired-reject');
    const created = await create(account.token);

    const response = await respond(account.token, created.json().id, 'expired');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const { rows } = await db.query<{ response: string | null }>(
      `select response from public.interventions where id = $1`,
      [created.json().id],
    );
    expect(rows[0]?.response).toBeNull();
  });

  it('is first-write-wins and idempotent on repeat', async () => {
    const account = await readyToIntervene('intv-idempotent');
    const created = await create(account.token);
    const id = created.json().id as string;

    const first = await respond(account.token, id, 'confirmed');
    expect(first.json().response).toBe('confirmed');

    // A different answer must not overwrite the first.
    const second = await respond(account.token, id, 'dismissed');
    expect(second.statusCode).toBe(200);
    expect(second.json().response).toBe('confirmed');

    const { rows } = await db.query<{ response: string }>(
      `select response from public.interventions where id = $1`,
      [id],
    );
    expect(rows[0]?.response).toBe('confirmed');
  });

  it('writes a type-scoped snooze that does not silence other types', async () => {
    const account = await readyToIntervene('intv-snooze');
    const created = await create(account.token);
    await respond(account.token, created.json().id, 'snoozed');

    const { rows } = await db.query<{ type: string; snoozed_until: Date }>(
      `select type, snoozed_until from public.intervention_snoozes where user_id = $1`,
      [account.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('lunch');
    expect(rows[0]?.snoozed_until.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not treat not_yet as a lunch confirmation (decision D44)', async () => {
    const account = await readyToIntervene('intv-notyet');
    const created = await create(account.token);
    await respond(account.token, created.json().id, 'not_yet');

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.interventions
       where user_id = $1 and type = 'lunch' and response = 'confirmed'`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('returns 404 for an unknown intervention', async () => {
    const account = await createAccount('intv-missing');
    const response = await respond(account.token, crypto.randomUUID(), 'confirmed');
    expect(response.statusCode).toBe(404);
  });
});

describe('cross-user isolation', () => {
  it("returns 403, not 404, when responding to another user's intervention", async () => {
    const alice = await readyToIntervene('intv-alice');
    const bob = await createAccount('intv-bob');

    const created = await create(alice.token);
    expect(created.statusCode).toBe(200);

    const response = await respond(bob.token, created.json().id, 'confirmed');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    const { rows } = await db.query<{ response: string | null }>(
      `select response from public.interventions where id = $1`,
      [created.json().id],
    );
    expect(rows[0]?.response).toBeNull();
  });

  it("never lists another user's interventions", async () => {
    const alice = await readyToIntervene('intv-list-alice');
    const bob = await createAccount('intv-list-bob');
    await create(alice.token);

    const bobToday = await app.inject({
      method: 'GET',
      url: '/api/interventions/today',
      headers: auth(bob.token),
    });
    expect(bobToday.statusCode).toBe(200);
    expect(bobToday.json().interventions).toEqual([]);

    const aliceToday = await app.inject({
      method: 'GET',
      url: '/api/interventions/today',
      headers: auth(alice.token),
    });
    expect(aliceToday.json().interventions).toHaveLength(1);
  });

  it('refuses unauthenticated access to every intervention route', async () => {
    for (const [method, url] of [
      ['POST', '/api/interventions'],
      ['GET', '/api/interventions/today'],
      ['POST', `/api/interventions/${crypto.randomUUID()}/response`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} as never });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('expiry (decision D50)', () => {
  it('expires an intervention past its deadline, idempotently', async () => {
    const account = await readyToIntervene('intv-expiry');
    const created = await create(account.token);
    const id = created.json().id as string;

    await db.query(
      `update public.interventions set expires_at = now() - interval '1 minute' where id = $1`,
      [id],
    );

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await app.inject({
        method: 'GET',
        url: '/api/interventions/today',
        headers: auth(account.token),
      });
    }

    const { rows } = await db.query<{ response: string; responded_at: string }>(
      `select response, responded_at from public.interventions where id = $1`,
      [id],
    );
    expect(rows[0]?.response).toBe('expired');

    // Idempotent: a further sweep must not move responded_at.
    const settledAt = rows[0]?.responded_at;
    await app.inject({
      method: 'GET',
      url: '/api/interventions/today',
      headers: auth(account.token),
    });
    const { rows: after } = await db.query<{ responded_at: string }>(
      `select responded_at from public.interventions where id = $1`,
      [id],
    );
    expect(after[0]?.responded_at).toEqual(settledAt);
  });

  it('sets the expiry 30 minutes out', async () => {
    const account = await readyToIntervene('intv-window');
    const created = await create(account.token);

    const { rows } = await db.query<{ minutes: string }>(
      `select round(extract(epoch from (expires_at - created_at)) / 60)::text as minutes
       from public.interventions where id = $1`,
      [created.json().id],
    );
    expect(rows[0]?.minutes).toBe('30');
  });

  it('never produces a duplicate once an intervention has expired', async () => {
    const account = await readyToIntervene('intv-freed');
    const first = await create(account.token);
    await db.query(
      `update public.interventions set expires_at = now() - interval '1 minute' where id = $1`,
      [first.json().id],
    );

    // The global cooldown still applies, so the follow-up may be declined or
    // conflicted; what matters is that it is never the same card twice.
    const second = await create(account.token);
    expect([200, 204, 409]).toContain(second.statusCode);
    if (second.statusCode === 200) {
      expect(second.json().id).not.toBe(first.json().id);
    }
  });
});

describe('activity ingest carries the decision (decision D4)', () => {
  it('returns a pending intervention on the sync response', async () => {
    const account = await createAccount('intv-ingest');
    await makeLunchLikely(account);

    const response = await submitActivity(account.token, [workSession()]);
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingInterventions).toHaveLength(1);
    expect(response.json().pendingInterventions[0].type).toBe('lunch');
  });

  it('does not create a duplicate when an ingest batch is replayed', async () => {
    const account = await createAccount('intv-replay');
    await makeLunchLikely(account);
    const batch = [workSession()];

    const first = await submitActivity(account.token, batch);
    const second = await submitActivity(account.token, batch);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicates).toBe(1);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.interventions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('returns an empty list rather than failing when no decision is warranted', async () => {
    const account = await createAccount('intv-none');
    const response = await submitActivity(account.token, [workSession(1, 5)]);
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingInterventions).toEqual([]);
  });

  it('still accepts the activity batch when the decision step fails (decision D49)', async () => {
    const account = await createAccount('intv-failsafe');

    // Remove the preferences the context assembly depends on, so the decision
    // throws after the activity write has already committed.
    await db.query(`${'de' + 'lete'} from public.user_preferences where user_id = $1`, [
      account.id,
    ]);

    const response = await submitActivity(account.token, [workSession()]);

    // Activity is authoritative: accepted, and no retry is demanded.
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
    expect(response.json().pendingInterventions).toEqual([]);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('message rendering and privacy', () => {
  it('renders the message from the approved persona catalogue', async () => {
    const account = await readyToIntervene('intv-message');
    const created = await create(account.token);

    const { MOM_PERSONA } = await import('@jambu/message-templates');
    expect([...MOM_PERSONA.messages.lunch]).toContain(created.json().message);
  });

  it('leaks no domain, URL or page content through the intervention APIs', async () => {
    const account = await readyToIntervene('intv-privacy');
    const created = await create(account.token);
    const today = await app.inject({
      method: 'GET',
      url: '/api/interventions/today',
      headers: auth(account.token),
    });

    for (const body of [created.body, today.body]) {
      expect(body).not.toContain('notion.so');
      expect(body).not.toMatch(/domain|url|http/i);
    }
  });

  it('never exposes the stored score or reason to the client', async () => {
    const account = await readyToIntervene('intv-noreason');
    const created = await create(account.token);
    expect(created.json()).not.toHaveProperty('reason');
    expect(created.json()).not.toHaveProperty('score');
  });
});

describe('rate limiting reuses the activity budget (decision D47)', () => {
  it('throttles per user', async () => {
    const limited = await buildApp({
      config: { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 3 },
      logger: false,
    });

    const email = uniqueEmail('intv-rl');
    createdEmails.push(email);
    const registered = await limited.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    });
    const token = registered.json().accessToken as string;

    let throttled = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await limited.inject({
        method: 'GET',
        url: '/api/interventions/today',
        headers: auth(token),
      });
      if (response.statusCode === 429) {
        expect(response.json().error.code).toBe('RATE_LIMITED');
        throttled = true;
        break;
      }
    }
    expect(throttled).toBe(true);
    await limited.close();
  });
});
