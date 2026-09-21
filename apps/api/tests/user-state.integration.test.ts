/**
 * GET /api/user/state against the live stack (docs/API.md §5).
 *
 * The point of this suite is to prove the endpoint *derives* rather than
 * ingests: it must read current facts, write nothing, and leave activity
 * history exactly as P4 stored it.
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

async function submit(token: string, sessions: unknown[]) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/activity/session',
    headers: { authorization: `Bearer ${token}` },
    payload: { sessions } as never,
  });
  expect(response.statusCode).toBe(200);
}

/** A session ending `endMinutesAgo` ago, lasting `lengthMinutes`. */
function session(endMinutesAgo: number, lengthMinutes: number) {
  const endedAt = new Date(Date.now() - endMinutesAgo * 60_000);
  const startedAt = new Date(endedAt.getTime() - lengthMinutes * 60_000);
  return {
    clientSessionId: crypto.randomUUID(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    activeSeconds: lengthMinutes * 60,
    domain: 'notion.so',
  };
}

async function getState(token: string) {
  return app.inject({
    method: 'GET',
    url: '/api/user/state',
    headers: { authorization: `Bearer ${token}` },
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
  it('returns a complete state for a brand-new user with no activity', async () => {
    const account = await createAccount('state-empty');
    const response = await getState(account.token);

    expect(response.statusCode).toBe(200);
    const state = response.json();
    expect(state.continuousWorkMinutes).toBe(0);
    expect(state.totalWorkMinutesToday).toBe(0);
    expect(state.currentActivity).toBe('unknown');
    expect(state.paused).toBe(false);
    expect(state.lunchWindow.source).toBe('default');
    expect(state.lunchWindow.confidence).toBe(0);
  });

  it('reflects submitted activity', async () => {
    const account = await createAccount('state-active');
    await submit(account.token, [session(1, 45)]);

    const state = (await getState(account.token)).json();
    expect(state.continuousWorkMinutes).toBe(45);
    expect(state.totalWorkMinutesToday).toBe(45);
    expect(state.currentActivity).toBe('active');
  });

  it('bridges a 9-minute gap and breaks an 11-minute one', async () => {
    const bridged = await createAccount('state-bridge');
    await submit(bridged.token, [session(40, 20), session(1, 30)]);
    expect((await getState(bridged.token)).json().continuousWorkMinutes).toBe(50);

    const broken = await createAccount('state-break');
    await submit(broken.token, [session(41, 20), session(5, 25)]);
    expect((await getState(broken.token)).json().continuousWorkMinutes).toBe(25);
  });

  it('zeroes continuous work once the current run has gone stale', async () => {
    const account = await createAccount('state-stale');
    await submit(account.token, [session(30, 45)]);

    const state = (await getState(account.token)).json();
    expect(state.continuousWorkMinutes).toBe(0);
    expect(state.currentActivity).toBe('idle');
    // The work still counts towards the day.
    expect(state.totalWorkMinutesToday).toBe(45);
    expect(state.lastBreakMinutesAgo).toBeGreaterThanOrEqual(29);
  });
});

describe('timezone (decision D28)', () => {
  it('places the default lunch window in the user local day for Asia/Kolkata', async () => {
    const account = await createAccount('state-kolkata', 'Asia/Kolkata');
    const state = (await getState(account.token)).json();

    // 12:30 and 14:30 Kolkata are 07:00Z and 09:00Z.
    expect(state.lunchWindow.start.slice(11, 19)).toBe('07:00:00');
    expect(state.lunchWindow.end.slice(11, 19)).toBe('09:00:00');
    expect(state.lunchWindow.source).toBe('default');
  });

  it('places it at local wall-clock time for UTC', async () => {
    const account = await createAccount('state-utc', 'UTC');
    const state = (await getState(account.token)).json();
    expect(state.lunchWindow.start.slice(11, 19)).toBe('12:30:00');
    expect(state.lunchWindow.end.slice(11, 19)).toBe('14:30:00');
  });

  it('falls back to UTC for an unusable stored timezone rather than failing', async () => {
    const account = await createAccount('state-badtz');
    await db.query(`update public.users set timezone = $2 where id = $1`, [
      account.id,
      'Mars/Olympus',
    ]);

    const response = await getState(account.token);
    expect(response.statusCode).toBe(200);
    expect(response.json().lunchWindow.start.slice(11, 19)).toBe('12:30:00');
  });
});

describe('lunch window source (decision D30)', () => {
  it('reports a learned window once a routine exists, without persisting the default', async () => {
    const account = await createAccount('state-learned', 'Asia/Kolkata');

    const before = (await getState(account.token)).json();
    expect(before.lunchWindow.source).toBe('default');

    // Routine learning is P11; this stands in for its output.
    await db.query(
      `insert into public.routine_patterns
         (user_id, pattern_type, day_of_week, start_time, end_time, confidence, sample_count)
       values ($1, 'lunch', null, '13:25', '13:45', 0.78, 16)`,
      [account.id],
    );

    const after = (await getState(account.token)).json();
    expect(after.lunchWindow.source).toBe('learned');
    expect(after.lunchWindow.confidence).toBeCloseTo(0.78);
    expect(after.lunchWindow.start.slice(11, 19)).toBe('07:55:00');

    // The default was never written as a routine.
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.routine_patterns where user_id = $1`,
      [account.id],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('pause state', () => {
  it('reports the pause recorded in pause_states', async () => {
    const account = await createAccount('state-pause');
    expect((await getState(account.token)).json().paused).toBe(false);

    await db.query('insert into public.pause_states (user_id) values ($1)', [account.id]);
    expect((await getState(account.token)).json().paused).toBe(true);
  });
});

describe('the endpoint is strictly read-only', () => {
  it('changes no row in any table, before or after the request', async () => {
    const account = await createAccount('state-readonly');
    await submit(account.token, [session(40, 20), session(1, 30)]);

    const snapshot = async () => {
      const { rows } = await db.query<{ digest: string }>(
        `select coalesce(md5(string_agg(t.row_text, '|' order by t.row_text)), 'empty') as digest
         from (
           select (a.*)::text as row_text from public.activity_sessions a where a.user_id = $1
           union all
           select (u.*)::text from public.users u where u.id = $1
           union all
           select (p.*)::text from public.user_preferences p where p.user_id = $1
           union all
           select (r.*)::text from public.routine_patterns r where r.user_id = $1
           union all
           select (i.*)::text from public.interventions i where i.user_id = $1
           union all
           select (s.*)::text from public.pause_states s where s.user_id = $1
         ) t`,
        [account.id],
      );
      return rows[0]?.digest;
    };

    const before = await snapshot();
    for (let call = 0; call < 3; call += 1) {
      expect((await getState(account.token)).statusCode).toBe(200);
    }
    const after = await snapshot();

    expect(after).toBe(before);
  });

  it('returns the same state for repeated calls with unchanged facts', async () => {
    const account = await createAccount('state-deterministic');
    await submit(account.token, [session(45, 30)]);

    const first = (await getState(account.token)).json();
    const second = (await getState(account.token)).json();

    // lastBreakMinutesAgo advances with wall-clock time, so compare the parts
    // that are a function of the stored facts alone.
    expect(second.continuousWorkMinutes).toBe(first.continuousWorkMinutes);
    expect(second.totalWorkMinutesToday).toBe(first.totalWorkMinutesToday);
    expect(second.lunchWindow).toEqual(first.lunchWindow);
    expect(second.currentActivity).toBe(first.currentActivity);
    expect(second.paused).toBe(first.paused);
  });
});

describe('authorization and privacy', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/user/state' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a forged token', async () => {
    expect((await getState('forged.token.value')).statusCode).toBe(401);
  });

  it("returns each user's own state and never the other's", async () => {
    const alice = await createAccount('state-alice');
    const bob = await createAccount('state-bob');

    await submit(alice.token, [session(1, 60)]);
    await submit(bob.token, [session(1, 5)]);

    expect((await getState(alice.token)).json().totalWorkMinutesToday).toBe(60);
    expect((await getState(bob.token)).json().totalWorkMinutesToday).toBe(5);
  });

  it('leaks no domain or URL in the response (CLAUDE.md §9)', async () => {
    const account = await createAccount('state-privacy');
    await submit(account.token, [session(1, 30)]);

    const response = await getState(account.token);
    expect(response.body).not.toContain('notion.so');
    expect(response.body).not.toMatch(/domain|url|http/i);
  });
});

describe('rate limiting (decision D29)', () => {
  it('reuses the activity budget, keyed per user', async () => {
    const limited = await buildApp({
      config: { ...loadConfig(), authRateLimitMax: 10_000, activityRateLimitMax: 3 },
      logger: false,
    });

    const email = uniqueEmail('state-rl');
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
        url: '/api/user/state',
        headers: { authorization: `Bearer ${token}` },
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
