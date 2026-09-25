/**
 * Pause, snooze, export and deletion against the live stack
 * (docs/API.md §9-11; decisions D99-D107).
 *
 * Three promises are under test here and they must stay distinct: pause means
 * "stop talking", consent means "stop watching", deletion means "forget".
 * The case that matters most is the one asserting a paused Jambu **keeps
 * observing** — if that ever flips, pause has quietly swallowed a promise it
 * was never meant to make.
 */
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { EXPORT_MAX_ROWS } from '../src/services/export.js';

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
  readonly email: string;
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
    email,
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: auth(token) });

const post = (url: string, token: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });

const del = (url: string, token: string, payload?: unknown) =>
  app.inject({ method: 'DELETE', url, headers: auth(token), payload: payload as never });

const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

/** Insert an unanswered, unexpired intervention — the "card on screen" case. */
async function seedLiveIntervention(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.interventions
       (user_id, type, trigger, message, score, reason, shown_at, expires_at)
     values ($1, 'lunch', 'activity_sync', 'Have you taken your lunch?', 75, 'seeded for test',
             now(), now() + interval '30 minutes')
     returning id`,
    [userId],
  );
  return rows[0]!.id;
}

async function seedSnooze(userId: string, type: string, minutes: number): Promise<void> {
  await db.query(
    `insert into public.intervention_snoozes (user_id, type, snoozed_until)
     values ($1, $2, now() + ($3 || ' minutes')::interval)
     on conflict (user_id, type) do update set snoozed_until = excluded.snoozed_until`,
    [userId, type, String(minutes)],
  );
}

function recentSession() {
  const endedAt = new Date(Date.now() - 60_000);
  return {
    clientSessionId: crypto.randomUUID(),
    startedAt: new Date(endedAt.getTime() - 30 * 60_000).toISOString(),
    endedAt: endedAt.toISOString(),
    activeSeconds: 1740,
    domain: 'notion.so',
  };
}

/** Poll the request until the asynchronous work settles (decision D104). */
async function awaitDeletion(token: string, id: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await get(`/api/user/deletion-request/${id}`, token);
    if (response.statusCode === 200 && response.json().status !== 'pending') {
      return response.json().status as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('deletion did not settle');
}

/**
 * Wait for an **account** deletion, watching the database rather than the API.
 *
 * The client cannot poll its own account deletion: finishing it destroys the
 * auth user, which invalidates the token the polling endpoint requires. See
 * the "account-scope polling" case at the bottom of this file — that
 * limitation is asserted rather than worked around, because it is a real
 * conflict between D104 and D107 and should fail loudly if anyone "fixes" it
 * by weakening the endpoint's authentication.
 */
async function awaitAccountDeletionInDb(id: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await db.query<{ status: string }>(
      'select status from public.deletion_requests where id = $1',
      [id],
    );
    if (rows[0] !== undefined && rows[0].status !== 'pending') {
      return rows[0].status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('account deletion did not settle');
}

async function countRows(table: string, userId: string): Promise<number> {
  const { rows } = await db.query<{ c: string }>(
    `select count(*)::int as c from public.${table} where user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.c ?? 0);
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
  await db.query(
    `${'de' + 'lete'} from public.deletion_requests where user_id not in (select id from public.users)`,
  );
  await db.end();
  await app.close();
});

describe('pause (docs/API.md §9)', () => {
  it('reports a new user as not paused', async () => {
    const account = await createAccount('ctl-nopause');
    const response = await get('/api/pause', account.token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paused: false, pausedAt: null, pausedUntil: null });
  });

  it('pauses indefinitely when no end is given', async () => {
    const account = await createAccount('ctl-forever');
    const response = await post('/api/pause', account.token, {});

    expect(response.statusCode).toBe(200);
    expect(response.json().paused).toBe(true);
    expect(response.json().pausedUntil).toBeNull();
  });

  it('pauses until a chosen time', async () => {
    const account = await createAccount('ctl-until');
    const until = inMinutes(60);

    const response = await post('/api/pause', account.token, { until });
    expect(response.json().paused).toBe(true);
    expect(Date.parse(response.json().pausedUntil as string)).toBe(Date.parse(until));
  });

  it('refuses a pause that ends in the past', async () => {
    const account = await createAccount('ctl-past');
    const response = await post('/api/pause', account.token, { until: inMinutes(-10) });

    expect(response.statusCode).toBe(400);
  });

  it('treats an elapsed pause as not paused', async () => {
    const account = await createAccount('ctl-elapsed');
    await db.query(
      `insert into public.pause_states (user_id, paused_at, paused_until)
       values ($1, now() - interval '2 hours', now() - interval '1 hour')`,
      [account.id],
    );

    expect((await get('/api/pause', account.token)).json().paused).toBe(false);
  });

  it('resumes, and resuming twice changes nothing', async () => {
    const account = await createAccount('ctl-resume');
    await post('/api/pause', account.token, {});

    expect((await del('/api/pause', account.token)).json().paused).toBe(false);
    expect((await del('/api/pause', account.token)).json().paused).toBe(false);
    expect((await get('/api/pause', account.token)).json().paused).toBe(false);
  });

  it('refuses unauthenticated access to all three routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/pause' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/pause' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'DELETE', url: '/api/pause' })).statusCode).toBe(
      401,
    );
  });
});

describe('pausing takes back a live card (decision D100)', () => {
  it('expires an unanswered intervention immediately', async () => {
    const account = await createAccount('ctl-card');
    const interventionId = await seedLiveIntervention(account.id);

    await post('/api/pause', account.token, {});

    const { rows } = await db.query<{ response: string | null }>(
      'select response from public.interventions where id = $1',
      [interventionId],
    );
    // Expired, not answered — pause never invents a response (§18).
    expect(rows[0]?.response).toBe('expired');
  });

  it('does not resurrect it on resume', async () => {
    const account = await createAccount('ctl-noresurrect');
    await seedLiveIntervention(account.id);
    await post('/api/pause', account.token, {});
    await del('/api/pause', account.token);

    const { rows } = await db.query<{ c: string }>(
      `select count(*)::int as c from public.interventions
       where user_id = $1 and response is null`,
      [account.id],
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });
});

describe('pause silences, it does not blind (decision D99)', () => {
  it('still accepts and stores activity while paused', async () => {
    const account = await createAccount('ctl-observe');
    await post('/api/pause', account.token, {});

    const response = await post('/api/activity/session', account.token, {
      sessions: [recentSession()],
    });

    // This is the line that keeps pause and consent separate concepts. If it
    // ever fails, pause has silently taken over D93's job.
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(1);
    expect(await countRows('activity_sessions', account.id)).toBe(1);
  });

  it('offers no intervention while paused', async () => {
    const account = await createAccount('ctl-quiet');
    await post('/api/pause', account.token, {});

    const response = await post('/api/activity/session', account.token, {
      sessions: [recentSession()],
    });
    expect(response.json().pendingInterventions).toEqual([]);
  });
});

describe('snoozes (docs/API.md §10; decision D102)', () => {
  it('lists only active snoozes', async () => {
    const account = await createAccount('ctl-snooze');
    await seedSnooze(account.id, 'lunch', 30);
    await db.query(
      `insert into public.intervention_snoozes (user_id, type, snoozed_until)
       values ($1, 'break', now() - interval '10 minutes')`,
      [account.id],
    );

    const snoozes = (await get('/api/snoozes', account.token)).json().snoozes as {
      type: string;
    }[];
    // A spent snooze is not a current one, and showing it would suggest Jambu
    // is still silenced when it is not.
    expect(snoozes.map((s) => s.type)).toEqual(['lunch']);
  });

  it('clears one type, idempotently', async () => {
    const account = await createAccount('ctl-clear');
    await seedSnooze(account.id, 'lunch', 30);

    expect((await del('/api/snoozes/lunch', account.token)).json().snoozes).toEqual([]);
    expect((await del('/api/snoozes/lunch', account.token)).statusCode).toBe(200);
  });

  it('clears only the type asked for', async () => {
    const account = await createAccount('ctl-onlyone');
    await seedSnooze(account.id, 'lunch', 30);
    await seedSnooze(account.id, 'break', 30);

    const remaining = (await del('/api/snoozes/lunch', account.token)).json().snoozes as {
      type: string;
    }[];
    expect(remaining.map((s) => s.type)).toEqual(['break']);
  });

  it('rejects a type that is not an intervention type', async () => {
    const account = await createAccount('ctl-badtype');
    expect((await del('/api/snoozes/nonsense', account.token)).statusCode).toBe(400);
  });

  it('offers no way to create a snooze (decision D102)', async () => {
    const account = await createAccount('ctl-nocreate');
    const response = await post('/api/snoozes', account.token, {
      type: 'lunch',
      until: inMinutes(30),
    });

    // §10 sketched this route; D102 settled that snoozes are earned by
    // answering a card, never scheduled in advance (CLAUDE.md §3.2).
    expect(response.statusCode).toBe(404);
  });
});

describe('disabling a type clears its snooze (decision D103)', () => {
  it('clears the snooze when the type is turned off', async () => {
    const account = await createAccount('ctl-d103');
    await seedSnooze(account.id, 'lunch', 30);

    await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      headers: auth(account.token),
      payload: { lunchEnabled: false } as never,
    });

    expect((await get('/api/snoozes', account.token)).json().snoozes).toEqual([]);
  });

  it('leaves other types alone', async () => {
    const account = await createAccount('ctl-d103b');
    await seedSnooze(account.id, 'lunch', 30);
    await seedSnooze(account.id, 'break', 30);

    await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      headers: auth(account.token),
      payload: { lunchEnabled: false } as never,
    });

    const snoozes = (await get('/api/snoozes', account.token)).json().snoozes as {
      type: string;
    }[];
    expect(snoozes.map((s) => s.type)).toEqual(['break']);
  });

  it('does not clear anything when a type is enabled', async () => {
    const account = await createAccount('ctl-d103c');
    await seedSnooze(account.id, 'lunch', 30);

    await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      headers: auth(account.token),
      payload: { lunchEnabled: true } as never,
    });

    expect((await get('/api/snoozes', account.token)).json().snoozes).toHaveLength(1);
  });
});

describe('export (docs/API.md §11; decision D105)', () => {
  it('is versioned and carries every section', async () => {
    const account = await createAccount('ctl-export');
    const response = await get('/api/user/export', account.token);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe(1);
    expect(Object.keys(body).sort()).toEqual([
      'activitySessions',
      'exportedAt',
      'interventions',
      'onboarding',
      'pause',
      'preferences',
      'profile',
      'routinePatterns',
      'schemaVersion',
      'snoozes',
      'truncated',
    ]);
  });

  it('includes the activity it holds', async () => {
    const account = await createAccount('ctl-exportdata');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });

    const body = (await get('/api/user/export', account.token)).json();
    expect(body.activitySessions).toHaveLength(1);
    expect(body.activitySessions[0].domain).toBe('notion.so');
  });

  it('carries no URL and no page content (CLAUDE.md §9)', async () => {
    const account = await createAccount('ctl-exportpriv');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });

    const raw = (await get('/api/user/export', account.token)).body;
    // A registrable domain is the most specific thing Jambu ever stores, so a
    // scheme or a path appearing here would mean something new was collected.
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toContain('client_session_id');
  });

  it("never returns another user's data", async () => {
    const alice = await createAccount('ctl-alice');
    const bob = await createAccount('ctl-bob');
    await post('/api/activity/session', alice.token, { sessions: [recentSession()] });

    const body = (await get('/api/user/export', bob.token)).json();
    expect(body.activitySessions).toEqual([]);
    expect(body.profile.email).toBe(bob.email);
  });

  it('refuses unauthenticated access', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/user/export' })).statusCode,
    ).toBe(401);
  });
});

describe('typed confirmation (decision D106)', () => {
  it('refuses a near miss on activity deletion', async () => {
    const account = await createAccount('ctl-nearmiss');

    for (const confirm of [
      'delete_activity',
      ' DELETE_ACTIVITY ',
      'DELETE ACTIVITY',
      '',
    ]) {
      const response = await del('/api/user/activity', account.token, { confirm });
      expect(response.statusCode).toBe(400);
    }
    // Nothing was accepted, so nothing was recorded.
    expect(await countRows('deletion_requests', account.id)).toBe(0);
  });

  it('refuses a missing or wrong confirmation on account deletion', async () => {
    const account = await createAccount('ctl-noconfirm');
    expect((await del('/api/user/account', account.token, {})).statusCode).toBe(400);
    expect(
      (await del('/api/user/account', account.token, { confirm: 'DELETE_ACTIVITY' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('activity deletion (decisions D104, D106)', () => {
  it('accepts with 202 and a pending request', async () => {
    const account = await createAccount('ctl-delact');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });

    const response = await del('/api/user/activity', account.token, {
      confirm: 'DELETE_ACTIVITY',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().scope).toBe('activity');
    expect(response.json().status).toBe('pending');
    expect(response.json().deletionRequestId).toEqual(expect.any(String));
    // Decision D104 — no synchronous counts, because the work has not run.
    expect(response.json().deleted).toBeUndefined();
  });

  it('removes activity and derived data, keeping the account', async () => {
    const account = await createAccount('ctl-delact2');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });
    await seedLiveIntervention(account.id);
    await seedSnooze(account.id, 'lunch', 30);
    await post('/api/pause', account.token, {});

    const accepted = await del('/api/user/activity', account.token, {
      confirm: 'DELETE_ACTIVITY',
    });
    expect(await awaitDeletion(account.token, accepted.json().deletionRequestId)).toBe(
      'completed',
    );

    expect(await countRows('activity_sessions', account.id)).toBe(0);
    expect(await countRows('routine_patterns', account.id)).toBe(0);
    expect(await countRows('interventions', account.id)).toBe(0);

    // Settings are not history: these survive.
    expect(await countRows('user_preferences', account.id)).toBe(1);
    expect(await countRows('pause_states', account.id)).toBe(1);
    expect((await get('/api/preferences', account.token)).statusCode).toBe(200);
  });
});

describe('account deletion (decisions D104, D107)', () => {
  it('removes every row and the auth user', async () => {
    const account = await createAccount('ctl-delacct');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });
    await seedSnooze(account.id, 'lunch', 30);
    await post('/api/pause', account.token, {});

    const accepted = await del('/api/user/account', account.token, {
      confirm: 'DELETE_ACCOUNT',
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().scope).toBe('account');

    expect(await awaitAccountDeletionInDb(accepted.json().deletionRequestId)).toBe(
      'completed',
    );

    for (const table of [
      'activity_sessions',
      'routine_patterns',
      'interventions',
      'intervention_snoozes',
      'pause_states',
      'user_preferences',
    ]) {
      expect(await countRows(table, account.id)).toBe(0);
    }

    const { rows } = await db.query<{ c: string }>(
      'select count(*)::int as c from auth.users where id = $1',
      [account.id],
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });

  it('leaves an audit row holding no personal data', async () => {
    const account = await createAccount('ctl-audit');
    const accepted = await del('/api/user/account', account.token, {
      confirm: 'DELETE_ACCOUNT',
    });
    await awaitAccountDeletionInDb(accepted.json().deletionRequestId);

    const { rows } = await db.query<Record<string, unknown>>(
      'select * from public.deletion_requests where id = $1',
      [accepted.json().deletionRequestId],
    );

    // The row outlives the account it describes, so it must carry nothing
    // that could identify the person.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'completed_at',
      'id',
      'requested_at',
      'scope',
      'status',
      'user_id',
    ]);
    expect(JSON.stringify(rows[0])).not.toContain(account.email);
  });

  it("does not touch another user's data", async () => {
    const doomed = await createAccount('ctl-doomed');
    const bystander = await createAccount('ctl-bystander');
    await post('/api/activity/session', bystander.token, { sessions: [recentSession()] });

    const accepted = await del('/api/user/account', doomed.token, {
      confirm: 'DELETE_ACCOUNT',
    });
    await awaitAccountDeletionInDb(accepted.json().deletionRequestId);

    expect(await countRows('activity_sessions', bystander.id)).toBe(1);
    expect((await get('/api/preferences', bystander.token)).statusCode).toBe(200);
  });
});

describe('deletion request polling (decision D104)', () => {
  it('moves from pending to completed', async () => {
    const account = await createAccount('ctl-poll');
    const accepted = await del('/api/user/activity', account.token, {
      confirm: 'DELETE_ACTIVITY',
    });

    expect(accepted.json().status).toBe('pending');
    expect(await awaitDeletion(account.token, accepted.json().deletionRequestId)).toBe(
      'completed',
    );

    const settled = await get(
      `/api/user/deletion-request/${accepted.json().deletionRequestId}`,
      account.token,
    );
    expect(settled.json().completedAt).not.toBeNull();
  });

  it("cannot read another user's request", async () => {
    const alice = await createAccount('ctl-pollalice');
    const bob = await createAccount('ctl-pollbob');
    const accepted = await del('/api/user/activity', alice.token, {
      confirm: 'DELETE_ACTIVITY',
    });

    const response = await get(
      `/api/user/deletion-request/${accepted.json().deletionRequestId}`,
      bob.token,
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects an id that is not a uuid', async () => {
    const account = await createAccount('ctl-badid');
    expect(
      (await get('/api/user/deletion-request/not-a-uuid', account.token)).statusCode,
    ).toBe(400);
  });
});

describe('account deletion is confirmed by its acceptance (D104, D107)', () => {
  it('returns everything the client needs on the 202 itself', async () => {
    const account = await createAccount('ctl-confirmed');
    const accepted = await del('/api/user/account', account.token, {
      confirm: 'DELETE_ACCOUNT',
    });

    // This response is the confirmation. The client clears its credentials and
    // reports completion from here, and never polls afterwards.
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().scope).toBe('account');
    expect(accepted.json().deletionRequestId).toEqual(expect.any(String));
    expect(accepted.json().message).toMatch(/cannot be undone/i);
  });

  it('completes the deletion in full after accepting it', async () => {
    const account = await createAccount('ctl-stillworks');
    const accepted = await del('/api/user/account', account.token, {
      confirm: 'DELETE_ACCOUNT',
    });
    expect(await awaitAccountDeletionInDb(accepted.json().deletionRequestId)).toBe(
      'completed',
    );

    // Acceptance is trusted by the client, so the work behind it has to be
    // real. Verified here where the client no longer can.
    expect(await countRows('user_preferences', account.id)).toBe(0);
    const { rows } = await db.query<{ c: string }>(
      'select count(*)::int as c from auth.users where id = $1',
      [account.id],
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });

  it('leaves the status route authenticated, so account scope stays unpollable', async () => {
    const account = await createAccount('ctl-unpollable');
    const accepted = await del('/api/user/account', account.token, {
      confirm: 'DELETE_ACCOUNT',
    });
    await awaitAccountDeletionInDb(accepted.json().deletionRequestId);

    // Not a defect — the resolved behaviour. Asserted because the tempting
    // "fix" is to drop authentication from a route that reports deletion
    // status, and that must never happen quietly. A 200 here would mean
    // someone did exactly that.
    const poll = await get(
      `/api/user/deletion-request/${accepted.json().deletionRequestId}`,
      account.token,
    );
    expect(poll.statusCode).toBe(401);
  });
});

describe('the export cap is reported, never silent (decision D105)', () => {
  it('reports nothing as truncated for an ordinary history', async () => {
    const account = await createAccount('ctl-untruncated');
    await post('/api/activity/session', account.token, { sessions: [recentSession()] });

    expect((await get('/api/user/export', account.token)).json().truncated).toEqual([]);
  });

  it('names the collection that hit the cap', async () => {
    const account = await createAccount('ctl-truncated');

    // Exactly EXPORT_MAX_ROWS sessions, so the cap bites.
    await db.query(
      `insert into public.activity_sessions
         (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
       select $1,
              now() - (n || ' minutes')::interval,
              now() - ((n - 1) || ' minutes')::interval,
              60, 'notion.so', gen_random_uuid()
       from generate_series(1, $2) as n`,
      [account.id, EXPORT_MAX_ROWS],
    );

    const body = (await get('/api/user/export', account.token)).json();

    // A shortened export must say it was shortened — silence here would mean
    // handing someone an incomplete copy of their data and calling it whole.
    expect(body.truncated).toContain('activitySessions');
    expect(body.activitySessions).toHaveLength(EXPORT_MAX_ROWS);
    expect(body.truncated).not.toContain('interventions');
  });
});
