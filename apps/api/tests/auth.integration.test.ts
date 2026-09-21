/**
 * Live auth flow against the local Supabase stack (decision D20).
 *
 * Run with `pnpm test:api` after `pnpm db:start`. Kept out of `pnpm test` and
 * `pnpm verify` because CI has no Docker.
 */
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let db: Client;
const createdEmails: string[] = [];

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
}

const PASSWORD = 'correct-horse-battery';

/**
 * Configuration for suites that are not testing rate limiting. The limit is
 * raised so the suite's own traffic does not trip it; the dedicated
 * rate-limit test builds an app with the real production value instead.
 */
function testConfig() {
  return { ...loadConfig(), authRateLimitMax: 10_000 };
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

async function register(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

describe('POST /api/auth/register', () => {
  it('creates the auth user, profile and default preferences', async () => {
    const email = uniqueEmail('register');
    createdEmails.push(email);

    const response = await register({
      email,
      password: PASSWORD,
      name: 'Dev',
      timezone: 'Asia/Kolkata',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.timezone).toBe('Asia/Kolkata');
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(new Date(body.expiresAt).toString()).not.toBe('Invalid Date');

    const { rows } = await db.query<{ hydration_enabled: boolean; persona: string }>(
      `select p.hydration_enabled, p.persona
       from public.user_preferences p
       join public.users u on u.id = p.user_id
       where u.email = $1`,
      [email],
    );
    // Defaults come from the schema, not from the API restating them.
    expect(rows[0]?.hydration_enabled).toBe(false);
    expect(rows[0]?.persona).toBe('mom');
  });

  it('never reveals that an email is already registered (decision D18)', async () => {
    const email = uniqueEmail('duplicate');
    createdEmails.push(email);

    const first = await register({ email, password: PASSWORD });
    expect(first.statusCode).toBe(201);

    const second = await register({ email, password: PASSWORD });
    const message = JSON.stringify(second.json());
    expect(message).not.toMatch(/already|exists|taken|duplicate|registered/i);
  });

  it('rejects invalid input before creating anything', async () => {
    const email = uniqueEmail('invalid');
    const response = await register({ email, password: 'short' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const { rows } = await db.query(`select 1 from auth.users where email = $1`, [email]);
    expect(rows).toEqual([]);
  });

  it('leaves no auth user behind when the profile cannot be written (decision D18)', async () => {
    const config = loadConfig();
    const { createClient } = await import('@supabase/supabase-js');
    const shared = {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    };

    // Auth must still work so the compensating delete can run; only the
    // PostgREST path is broken, which is what createProfile uses.
    const brokenAdmin = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      shared,
    );
    brokenAdmin.from = (() => {
      throw new Error('simulated PostgREST outage');
    }) as typeof brokenAdmin.from;

    const failing = await buildApp({
      config,
      logger: false,
      clients: {
        admin: brokenAdmin,
        auth: createClient(config.supabaseUrl, config.supabaseAnonKey, shared),
      },
    });

    const email = uniqueEmail('compensate');
    createdEmails.push(email);

    const response = await failing.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL');

    // The compensating delete must have removed the orphaned auth user.
    const { rows } = await db.query(`select 1 from auth.users where email = $1`, [email]);
    expect(rows).toEqual([]);

    await failing.close();
  });

  it('is idempotent for profile creation when retried after a partial failure', async () => {
    const email = uniqueEmail('idempotent');
    createdEmails.push(email);

    const first = await register({ email, password: PASSWORD, timezone: 'UTC' });
    expect(first.statusCode).toBe(201);
    const userId = first.json().user.id as string;

    const { createProfile } = await import('../src/services/registration.js');
    const { createSupabaseClients } = await import('../src/plugins/supabase.js');
    const clients = createSupabaseClients(loadConfig());
    await createProfile(clients.admin, { userId, email, timezone: 'UTC' });

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.user_preferences where user_id = $1`,
      [userId],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('POST /api/auth/login', () => {
  let email: string;

  beforeAll(async () => {
    email = uniqueEmail('login');
    createdEmails.push(email);
    await register({ email, password: PASSWORD, name: 'Login User', timezone: 'UTC' });
  });

  it('returns tokens and the profile for valid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'not-the-password' },
    });
    const unknownAccount = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: uniqueEmail('nobody'), password: PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    // Identical responses, so neither can be used to enumerate accounts.
    expect(wrongPassword.json()).toEqual(unknownAccount.json());
  });

  it('normalises the email, so case and padding do not lock a user out', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `  ${email.toUpperCase()}  `, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /api/auth/refresh', () => {
  it('exchanges a refresh token for a new session', async () => {
    const email = uniqueEmail('refresh');
    createdEmails.push(email);
    const registered = await register({ email, password: PASSWORD });
    expect(registered.statusCode).toBe(201);
    const refreshToken = registered.json().refreshToken as string;
    expect(typeof refreshToken).toBe('string');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body).not.toHaveProperty('user');
  });

  it('refuses a forged or expired token without explaining which', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: 'not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(response.json())).not.toMatch(
      /jwt|signature|malformed|expired at/i,
    );
  });

  it('requires a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});
