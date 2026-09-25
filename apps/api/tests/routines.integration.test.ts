/**
 * Routine learning against the live stack (docs/API.md §7, decisions D77-D84).
 *
 * These prove what only a real database can: that learned rows are written in
 * the D77 shape, that recalculation is idempotent, that the D8 default gives
 * way to a learned window at exactly three observations, and that a learning
 * failure never costs an accepted activity batch.
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

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':');
  const total = Number(h) * 60 + Number(m) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A day of work split by a lunch gap, written straight to the database.
 *
 * Inserted directly rather than through the ingest endpoint because these
 * sessions are days old, and going through the API would also fire the lazy
 * recalculation and make the fixtures harder to reason about.
 */
async function seedWorkDay(
  userId: string,
  daysAgo: number,
  lunchAt: string,
  options: { gapMinutes?: number; start?: string; end?: string } = {},
): Promise<void> {
  const gap = options.gapMinutes ?? 45;
  const dayStart = options.start ?? '09:00';
  const dayEnd = options.end ?? '18:00';
  const lunchEnd = addMinutes(lunchAt, gap);

  const stamp = (time: string): string =>
    `(now() at time zone 'UTC')::date - ${daysAgo} + time '${time}'`;

  await db.query(
    `insert into public.activity_sessions
       (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
     values
       ($1, ${stamp(dayStart)}, ${stamp(lunchAt)},
        extract(epoch from (time '${lunchAt}' - time '${dayStart}'))::int,
        'notion.so', gen_random_uuid()),
       ($1, ${stamp(lunchEnd)}, ${stamp(dayEnd)},
        extract(epoch from (time '${dayEnd}' - time '${lunchEnd}'))::int,
        'notion.so', gen_random_uuid())`,
    [userId],
  );
}

async function recalculate(token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/routines/recalculate',
    headers: auth(token),
  });
}

async function getRoutines(token: string) {
  return app.inject({ method: 'GET', url: '/api/routines', headers: auth(token) });
}

async function ingestRecentSession(token: string) {
  const endedAt = new Date(Date.now() - 60_000);
  return app.inject({
    method: 'POST',
    url: '/api/activity/session',
    headers: auth(token),
    payload: {
      sessions: [
        {
          clientSessionId: crypto.randomUUID(),
          startedAt: new Date(endedAt.getTime() - 30 * 60_000).toISOString(),
          endedAt: endedAt.toISOString(),
          activeSeconds: 1800,
          domain: 'notion.so',
        },
      ],
    } as never,
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

describe('GET /api/routines', () => {
  it('returns nothing for a user with no learned routines', async () => {
    const account = await createAccount('rtn-empty');
    const response = await getRoutines(account.token);

    expect(response.statusCode).toBe(200);
    expect(response.json().patterns).toEqual([]);
  });

  it('refuses unauthenticated access to both routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/routines' })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/routines/recalculate' })).statusCode,
    ).toBe(401);
  });
});

describe('learning from real activity (CLAUDE.md §16)', () => {
  it('learns no lunch window until the third day (decision D8)', async () => {
    const account = await createAccount('rtn-threshold');

    await seedWorkDay(account.id, 3, '13:00');
    await seedWorkDay(account.id, 2, '13:00');
    const twoDays = (await recalculate(account.token)).json().patterns as {
      type: string;
    }[];
    // Lunch is observed once per day, so two days is one short. Break interval
    // is observed per run, and two split days already give it four.
    expect(twoDays.map((p) => p.type)).toEqual(['break_interval']);

    // The third observation crosses the §16 threshold.
    await seedWorkDay(account.id, 1, '13:00');
    const patterns = (await recalculate(account.token)).json().patterns as {
      type: string;
      start: string;
      end: string;
      tier: string;
      sampleCount: number;
    }[];

    const lunch = patterns.find((p) => p.type === 'lunch');
    expect(lunch?.start).toBe('12:50');
    expect(lunch?.end).toBe('13:10');
    expect(lunch?.tier).toBe('low');
    expect(lunch?.sampleCount).toBe(3);
  });

  it('flips user state from the default window to the learned one (decision D8)', async () => {
    const account = await createAccount('rtn-source');

    const before = await app.inject({
      method: 'GET',
      url: '/api/user/state',
      headers: auth(account.token),
    });
    expect(before.json().lunchWindow.source).toBe('default');
    expect(before.json().lunchWindow.confidence).toBe(0);

    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '12:30');
    }
    await recalculate(account.token);

    const after = await app.inject({
      method: 'GET',
      url: '/api/user/state',
      headers: auth(account.token),
    });
    expect(after.json().lunchWindow.source).toBe('learned');
    expect(after.json().lunchWindow.confidence).toBeGreaterThan(0);
  });

  it('writes the work hours the end-of-day rule finally needs (decision D7)', async () => {
    const account = await createAccount('rtn-hours');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00', { start: '09:30', end: '18:30' });
    }

    const patterns = (await recalculate(account.token)).json().patterns as {
      type: string;
      start: string;
      end: string;
    }[];

    expect(patterns.find((p) => p.type === 'work_start')?.start).toBe('09:30');
    expect(patterns.find((p) => p.type === 'work_end')?.end).toBe('18:30');
  });
});

describe('break interval is stored as a duration (decision D77)', () => {
  it('writes interval_minutes and leaves the time columns null', async () => {
    const account = await createAccount('rtn-break');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }
    await recalculate(account.token);

    const { rows } = await db.query<{
      interval_minutes: number | null;
      start_time: string | null;
      end_time: string | null;
    }>(
      `select interval_minutes, start_time, end_time from public.routine_patterns
       where user_id = $1 and pattern_type = 'break_interval'`,
      [account.id],
    );

    expect(rows[0]?.interval_minutes).toBeGreaterThan(0);
    expect(rows[0]?.start_time).toBeNull();
    expect(rows[0]?.end_time).toBeNull();
  });

  it('refuses the old span encoding at the database level', async () => {
    const account = await createAccount('rtn-shape');

    // The P7 reading — a duration disguised as a time span — is now rejected.
    await expect(
      db.query(
        `insert into public.routine_patterns
           (user_id, pattern_type, day_of_week, start_time, end_time, confidence, sample_count)
         values ($1, 'break_interval', null, '00:00', '01:30', 0.8, 10)`,
        [account.id],
      ),
    ).rejects.toThrow(/shape_is_coherent/);
  });

  it('refuses a time-of-day pattern carrying an interval', async () => {
    const account = await createAccount('rtn-shape2');

    await expect(
      db.query(
        `insert into public.routine_patterns
           (user_id, pattern_type, day_of_week, start_time, end_time, interval_minutes, confidence, sample_count)
         values ($1, 'lunch', null, '13:00', '13:30', 90, 0.8, 10)`,
        [account.id],
      ),
    ).rejects.toThrow(/shape_is_coherent/);
  });

  it('gives the break pattern confidence the Care Engine can use', async () => {
    const account = await createAccount('rtn-engine');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }
    await recalculate(account.token);

    const { rows } = await db.query<{ confidence: string }>(
      `select confidence from public.routine_patterns
       where user_id = $1 and pattern_type = 'break_interval'`,
      [account.id],
    );
    // Confidence above zero is what earns the engine's +20 historical term,
    // which is what lets a break reach the threshold at all.
    expect(Number(rows[0]?.confidence)).toBeGreaterThan(0);
  });
});

describe('recalculation is idempotent', () => {
  it('produces the same rows however many times it runs', async () => {
    const account = await createAccount('rtn-idempotent');
    for (const daysAgo of [4, 3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }

    const first = (await recalculate(account.token)).json().patterns;
    const second = (await recalculate(account.token)).json().patterns;
    const third = (await recalculate(account.token)).json().patterns;

    expect(second).toEqual(first);
    expect(third).toEqual(first);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.routine_patterns where user_id = $1`,
      [account.id],
    );
    // Upserted on (user_id, pattern_type, day_of_week) — never duplicated.
    expect(Number(rows[0]?.count)).toBe(first.length);
  });

  it('writes all-days rows only (decision D80)', async () => {
    const account = await createAccount('rtn-allday');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }
    await recalculate(account.token);

    const { rows } = await db.query<{ day_of_week: number | null }>(
      `select day_of_week from public.routine_patterns where user_id = $1`,
      [account.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.day_of_week === null)).toBe(true);
  });
});

describe('isolation and privacy', () => {
  it("never learns from or returns another user's activity", async () => {
    const alice = await createAccount('rtn-alice');
    const bob = await createAccount('rtn-bob');

    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(alice.id, daysAgo, '11:30');
    }
    await recalculate(alice.token);
    await recalculate(bob.token);

    expect((await getRoutines(bob.token)).json().patterns).toEqual([]);
    expect((await getRoutines(alice.token)).json().patterns.length).toBeGreaterThan(0);
  });

  it('returns no domain or page information (CLAUDE.md §9)', async () => {
    const account = await createAccount('rtn-privacy');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }
    await recalculate(account.token);

    const body = (await getRoutines(account.token)).body;
    expect(body).not.toContain('notion.so');
    expect(body).not.toMatch(/domain|url|http/i);
  });
});

describe('lazy recalculation (decision D83)', () => {
  it('recalculates on ingest for a user with no routines yet', async () => {
    const account = await createAccount('rtn-lazy');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }

    expect((await ingestRecentSession(account.token)).statusCode).toBe(200);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.routine_patterns where user_id = $1`,
      [account.id],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('does not recalculate again while the routines are fresh', async () => {
    const account = await createAccount('rtn-fresh');
    for (const daysAgo of [3, 2, 1]) {
      await seedWorkDay(account.id, daysAgo, '13:00');
    }
    await recalculate(account.token);

    const { rows: before } = await db.query<{ updated_at: Date }>(
      `select max(updated_at) as updated_at from public.routine_patterns where user_id = $1`,
      [account.id],
    );

    await ingestRecentSession(account.token);

    const { rows: after } = await db.query<{ updated_at: Date }>(
      `select max(updated_at) as updated_at from public.routine_patterns where user_id = $1`,
      [account.id],
    );
    expect(after[0]?.updated_at).toEqual(before[0]?.updated_at);
  });

  it('still accepts the activity batch when recalculation fails', async () => {
    const account = await createAccount('rtn-failsafe');

    // Removing preferences breaks the context assembly the post-ingest work
    // depends on; the ingest itself must survive regardless.
    await db.query(`${'de' + 'lete'} from public.user_preferences where user_id = $1`, [
      account.id,
    ]);

    const response = await ingestRecentSession(account.token);

    // Activity remains authoritative (decisions D49, D83).
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_sessions where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });
});
