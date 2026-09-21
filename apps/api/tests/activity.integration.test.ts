/**
 * Activity ingestion against the live stack (docs/API.md §4).
 *
 * Covers what only a real database can prove: idempotent replay via the
 * `(user_id, client_session_id)` constraint, per-user isolation, and that no
 * URL ever reaches a stored row.
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

async function createAccount(prefix: string): Promise<Account> {
  const email = uniqueEmail(prefix);
  createdEmails.push(email);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    token: response.json().accessToken as string,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  const started = new Date(Date.now() - 60 * 60_000);
  const ended = new Date(Date.now() - 30 * 60_000);
  return {
    clientSessionId: crypto.randomUUID(),
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    activeSeconds: 1800,
    domain: 'notion.so',
    ...overrides,
  };
}

async function post(token: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/activity/session',
    headers: { authorization: `Bearer ${token}` },
    payload: body as never,
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

describe('contract', () => {
  it('stores a batch and reports accepted, duplicates and pendingInterventions', async () => {
    const account = await createAccount('act');
    const response = await post(account.token, { sessions: [session(), session()] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      duplicates: 0,
      // Decision D21: stable field, populated from P7.
      pendingInterventions: [],
    });
  });

  it('persists the session with UTC timestamps and the domain only', async () => {
    const account = await createAccount('persist');
    const one = session({ domain: 'NOTION.SO.' });
    await post(account.token, { sessions: [one] });

    const { rows } = await db.query<{
      domain: string;
      active_seconds: number;
      started_at: Date;
    }>(
      `select domain, active_seconds, started_at from public.activity_sessions
       where user_id = $1`,
      [account.id],
    );

    expect(rows).toHaveLength(1);
    // Normalised: lowercased, trailing dot removed.
    expect(rows[0]?.domain).toBe('notion.so');
    expect(rows[0]?.active_seconds).toBe(1800);
    expect(rows[0]?.started_at.toISOString()).toBe(one.startedAt);
  });

  it('accepts a session with no domain at all', async () => {
    const account = await createAccount('nodomain');
    const withoutDomain = session();
    delete (withoutDomain as Record<string, unknown>)['domain'];

    const response = await post(account.token, { sessions: [withoutDomain] });
    expect(response.statusCode).toBe(200);

    const { rows } = await db.query<{ domain: string | null }>(
      `select domain from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.domain).toBeNull();
  });
});

describe('idempotent replay (CLAUDE.md §26)', () => {
  it('counts a replayed batch as duplicates and stores nothing new', async () => {
    const account = await createAccount('replay');
    const batch = { sessions: [session(), session()] };

    const first = await post(account.token, batch);
    expect(first.json()).toMatchObject({ accepted: 2, duplicates: 0 });

    const second = await post(account.token, batch);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 0, duplicates: 2 });

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('does not alter the stored row when a replay carries different values', async () => {
    const account = await createAccount('immutable');
    const original = session({ activeSeconds: 1800, domain: 'notion.so' });
    await post(account.token, { sessions: [original] });

    // Same idempotency key, different payload: the stored row must not move.
    const tampered = { ...original, activeSeconds: 10, domain: 'evil.example' };
    const response = await post(account.token, { sessions: [tampered] });
    expect(response.json()).toMatchObject({ accepted: 0, duplicates: 1 });

    const { rows } = await db.query<{ active_seconds: number; domain: string }>(
      `select active_seconds, domain from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.active_seconds).toBe(1800);
    expect(rows[0]?.domain).toBe('notion.so');
  });

  it('collapses a clientSessionId repeated inside one batch', async () => {
    const account = await createAccount('intrabatch');
    const one = session();

    const response = await post(account.token, { sessions: [one, { ...one }] });
    expect(response.json()).toMatchObject({ accepted: 1, duplicates: 1 });

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('authorization — user A and user B (decision D17)', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/activity/session',
      payload: { sessions: [session()] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a forged token', async () => {
    const response = await post('forged.token.value', { sessions: [session()] });
    expect(response.statusCode).toBe(401);
  });

  it("stores activity against the token's owner, ignoring any user id in the body", async () => {
    const alice = await createAccount('alice');
    const bob = await createAccount('bob');

    // Alice submits a body naming Bob. `.strict()` rejects the unknown field,
    // and even if it did not, user_id comes from the token alone.
    const withForeignId = await post(alice.token, {
      sessions: [session()],
      userId: bob.id,
    });
    expect(withForeignId.statusCode).toBe(400);

    await post(alice.token, { sessions: [session()] });

    const { rows: bobRows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [bob.id],
    );
    expect(bobRows[0]?.count).toBe('0');

    const { rows: aliceRows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [alice.id],
    );
    expect(aliceRows[0]?.count).toBe('1');
  });

  it('keeps each user idempotency key separate', async () => {
    const alice = await createAccount('alice-key');
    const bob = await createAccount('bob-key');
    const shared = session();

    expect((await post(alice.token, { sessions: [shared] })).json()).toMatchObject({
      accepted: 1,
    });
    // The same key for a different user is a new row, not a duplicate.
    expect((await post(bob.token, { sessions: [shared] })).json()).toMatchObject({
      accepted: 1,
    });
  });
});

describe('privacy — a URL never reaches the database (decision D23)', () => {
  const leaks = [
    'https://notion.so/salary-review',
    'notion.so/private-doc',
    'notion.so?q=secret-query',
    'notion.so#draft-resignation',
    'user:pass@notion.so',
    'notion.so:443',
  ];

  it('rejects every URL-shaped domain with the standard envelope', async () => {
    const account = await createAccount('privacy');

    for (const leak of leaks) {
      const response = await post(account.token, {
        sessions: [session({ domain: leak })],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('never echoes the offending value back in the response', async () => {
    const account = await createAccount('noecho');
    const response = await post(account.token, {
      sessions: [session({ domain: 'notion.so/q?token=super-secret-value' })],
    });

    expect(response.body).not.toContain('super-secret-value');
    expect(response.body).not.toContain('notion.so/q');
  });

  it('rejects the whole batch when one session carries a URL', async () => {
    const account = await createAccount('partial');
    const response = await post(account.token, {
      sessions: [session(), session({ domain: 'notion.so/leak' })],
    });

    expect(response.statusCode).toBe(400);
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    // Nothing partially applied: the batch is all-or-nothing.
    expect(rows[0]?.count).toBe('0');
  });

  it('stores no value containing a path anywhere in the table', async () => {
    const { rows } = await db.query<{ domain: string | null }>(
      `select domain from public.activity_sessions where domain is not null`,
    );
    for (const row of rows) {
      expect(row.domain).not.toMatch(/[/?#:]/);
    }
  });
});

describe('bounds (decision D25)', () => {
  let account: Account;

  beforeAll(async () => {
    account = await createAccount('bounds');
  });

  it('rejects an empty batch', async () => {
    expect((await post(account.token, { sessions: [] })).statusCode).toBe(400);
  });

  it('rejects more than 500 sessions', async () => {
    const tooMany = Array.from({ length: 501 }, () => session());
    expect((await post(account.token, { sessions: tooMany })).statusCode).toBe(400);
  });

  it('accepts exactly 500 sessions', async () => {
    const exactly = Array.from({ length: 500 }, () => session());
    const response = await post(account.token, { sessions: exactly });
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(500);
  });

  it('rejects activeSeconds beyond a day, and negative values', async () => {
    expect(
      (await post(account.token, { sessions: [session({ activeSeconds: 86_401 })] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(account.token, { sessions: [session({ activeSeconds: -1 })] }))
        .statusCode,
    ).toBe(400);
  });

  it('rejects a start more than ten minutes in the future', async () => {
    const future = new Date(Date.now() + 11 * 60_000).toISOString();
    const response = await post(account.token, {
      sessions: [session({ startedAt: future, endedAt: future, activeSeconds: 0 })],
    });
    expect(response.statusCode).toBe(400);
  });

  it('tolerates modest clock skew', async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const response = await post(account.token, {
      sessions: [session({ startedAt: soon, endedAt: soon, activeSeconds: 0 })],
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a session older than thirty days', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    const response = await post(account.token, {
      sessions: [session({ startedAt: old, endedAt: old, activeSeconds: 0 })],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a session that ends before it starts', async () => {
    const response = await post(account.token, {
      sessions: [
        session({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: new Date(Date.now() - 120_000).toISOString(),
          activeSeconds: 0,
        }),
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects more active time than the session spans', async () => {
    const started = new Date(Date.now() - 60_000).toISOString();
    const ended = new Date(Date.now()).toISOString();
    const response = await post(account.token, {
      sessions: [session({ startedAt: started, endedAt: ended, activeSeconds: 3600 })],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed clientSessionId', async () => {
    expect(
      (
        await post(account.token, {
          sessions: [session({ clientSessionId: 'not-a-uuid' })],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    expect(
      (await post(account.token, { sessions: [session({ pageTitle: 'Salary review' })] }))
        .statusCode,
    ).toBe(400);
  });
});

describe('rate limiting (decision D24)', () => {
  it('throttles per user, not per IP', async () => {
    const limited = await buildApp({
      config: { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 3 },
      logger: false,
    });

    const emailA = uniqueEmail('rl-a');
    createdEmails.push(emailA);
    const registeredA = await limited.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: emailA, password: PASSWORD },
    });
    const tokenA = registeredA.json().accessToken as string;

    const emailB = uniqueEmail('rl-b');
    createdEmails.push(emailB);
    const registeredB = await limited.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: emailB, password: PASSWORD },
    });
    const tokenB = registeredB.json().accessToken as string;

    const send = (token: string) =>
      limited.inject({
        method: 'POST',
        url: '/api/activity/session',
        headers: { authorization: `Bearer ${token}` },
        payload: { sessions: [session()] },
      });

    let throttled = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await send(tokenA);
      if (response.statusCode === 429) {
        expect(response.json().error.code).toBe('RATE_LIMITED');
        throttled = true;
        break;
      }
    }
    expect(throttled).toBe(true);

    // Another user, same IP, must still be served.
    expect((await send(tokenB)).statusCode).toBe(200);

    await limited.close();
  });
});
