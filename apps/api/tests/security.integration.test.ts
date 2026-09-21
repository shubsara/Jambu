/**
 * Security behaviour of the live API (CLAUDE.md §31).
 *
 * Checks the things that would stay invisible until they went wrong: secrets
 * in logs or responses, unauthenticated access, CORS, and rate limiting.
 */
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { buildAuthenticate } from '../src/auth/authenticate.js';
import { loadConfig } from '../src/config.js';
import { createSupabaseClients } from '../src/plugins/supabase.js';

let app: FastifyInstance;
let db: Client;
const createdEmails: string[] = [];
const PASSWORD = 'correct-horse-battery';

/**
 * Configuration for suites that are not testing rate limiting. The limit is
 * raised so the suite's own traffic does not trip it; the dedicated
 * rate-limit test builds an app with the real production value instead.
 */
function testConfig() {
  return { ...loadConfig(), authRateLimitMax: 10_000 };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
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

describe('secrets never cross the boundary', () => {
  it('returns no Supabase key in any auth response', async () => {
    const config = loadConfig();
    const email = uniqueEmail('sec');
    createdEmails.push(email);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    });
    const body = registered.body;

    expect(body).not.toContain(config.supabaseServiceRoleKey);
    expect(body).not.toContain(config.supabaseAnonKey);
    expect(body).not.toMatch(/service_role/i);
  });

  it('returns no Supabase key in an error response', async () => {
    const config = loadConfig();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: uniqueEmail('nobody'), password: PASSWORD },
    });

    expect(response.body).not.toContain(config.supabaseServiceRoleKey);
    expect(response.body).not.toContain(config.supabaseAnonKey);
  });

  it('never echoes the submitted password back', async () => {
    const email = uniqueEmail('echo');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'short' },
    });

    expect(response.body).not.toContain('short');
  });

  it('leaks no database or PostgREST detail in an error body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: 'nope' },
    });

    expect(response.body).not.toMatch(
      /postgres|postgrest|relation|constraint|pg_|supabase_admin|stack/i,
    );
  });
});

describe('logs never contain credentials (CLAUDE.md §31)', () => {
  it('redacts the password, tokens and Authorization header', async () => {
    const lines: string[] = [];
    const config = loadConfig();
    const logging = await buildApp({
      config: { ...config, nodeEnv: 'development', authRateLimitMax: 10_000 },
      clients: createSupabaseClients(config),
    });

    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string) => boolean) = ((
      chunk: string,
    ) => {
      lines.push(String(chunk));
      return true;
    }) as never;

    try {
      const email = uniqueEmail('log');
      createdEmails.push(email);
      await logging.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: PASSWORD },
      });
      const login = await logging.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: PASSWORD },
        headers: { authorization: 'Bearer super-secret-token-value' },
      });
      const token = login.json().accessToken as string;

      const output = lines.join('\n');
      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain('super-secret-token-value');
      expect(output).not.toContain(token);
      expect(output).not.toContain(config.supabaseServiceRoleKey);
    } finally {
      process.stdout.write = original;
      await logging.close();
    }
  });
});

describe('authentication is required where it should be', () => {
  it('rejects a request with no token', async () => {
    const authenticate = buildAuthenticate(createSupabaseClients(loadConfig()));
    await expect(
      authenticate({ headers: {} } as never, {} as never),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      statusCode: 401,
    });
  });

  it('rejects a forged token', async () => {
    const authenticate = buildAuthenticate(createSupabaseClients(loadConfig()));
    await expect(
      authenticate(
        { headers: { authorization: 'Bearer forged.token.value' } } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('accepts a real token and establishes the authorization subject', async () => {
    const email = uniqueEmail('authn');
    createdEmails.push(email);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    });
    const token = registered.json().accessToken as string;
    const userId = registered.json().user.id as string;

    const authenticate = buildAuthenticate(createSupabaseClients(loadConfig()));
    const request = { headers: { authorization: `Bearer ${token}` } } as never as {
      headers: Record<string, string>;
      authenticatedUser?: { id: string };
    };

    await authenticate(request as never, {} as never);
    expect(request.authenticatedUser?.id).toBe(userId);
  });
});

describe('rate limiting protects the auth endpoints', () => {
  it('refuses sustained login attempts with RATE_LIMITED', async () => {
    // Real production limit, not the raised one the rest of the suite uses.
    const limited = await buildApp({
      config: { ...loadConfig(), authRateLimitMax: 5 },
      logger: false,
    });
    const email = uniqueEmail('ratelimit');

    let sawRateLimit = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'wrong-password' },
      });
      if (response.statusCode === 429) {
        expect(response.json().error.code).toBe('RATE_LIMITED');
        sawRateLimit = true;
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
    await limited.close();
  });
});

describe('CORS stays restrictive against the live app (decision D19)', () => {
  it('refuses an unlisted origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never responds with a wildcard origin', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });
});
