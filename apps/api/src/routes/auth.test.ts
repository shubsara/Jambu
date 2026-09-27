/**
 * Registration's sign-up call, with Supabase stubbed.
 *
 * Lives here rather than in `apps/api/tests` so it runs in `pnpm verify`: the
 * thing under test is the argument the API sends, which needs no database to
 * observe. The live suite still covers the real round-trip.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import type { SupabaseClients } from '../plugins/supabase.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'anon',
  supabaseServiceRoleKey: 'service-role',
  allowedOrigins: ['http://127.0.0.1:3000'],
  authRateLimitMax: 10_000,
  activityRateLimitMax: 10_000,
  interventionExpiryMinutes: 30,
  interventionSnoozeMinutes: 30,
  version: '9.9.9',
};

const USER_ID = '11111111-1111-4111-8111-111111111111';

interface SignUpCall {
  readonly email: string;
  readonly password: string;
  readonly options?: { readonly emailRedirectTo?: string };
}

/**
 * A Supabase double that records the sign-up argument and reports the
 * confirmation-enabled shape: a user, and no session (resolution A3).
 */
function stubClients(): { clients: SupabaseClients; calls: SignUpCall[] } {
  const calls: SignUpCall[] = [];

  const auth = {
    auth: {
      signUp: async (argument: SignUpCall) => {
        calls.push(argument);
        return {
          data: { user: { id: USER_ID }, session: null },
          error: null,
        };
      },
    },
  };

  // `users` is upserted then read back through `.select().single()`;
  // `user_preferences` is awaited directly. One thenable satisfies both.
  const admin = {
    from: (table: string) => ({
      upsert: () => ({
        select: () => ({
          single: async () => ({
            data: {
              id: USER_ID,
              email: 'someone@example.com',
              name: null,
              timezone: 'Asia/Kolkata',
            },
            error: null,
          }),
        }),
        then: (resolve: (value: { error: null }) => void) => {
          expect(table).toBe('user_preferences');
          resolve({ error: null });
        },
      }),
    }),
  };

  return {
    clients: {
      auth: auth as unknown as SupabaseClient,
      admin: admin as unknown as SupabaseClient,
    },
    calls,
  };
}

async function register(body: Record<string, unknown>): Promise<{
  statusCode: number;
  calls: SignUpCall[];
}> {
  const { clients, calls } = stubClients();
  const app = await buildApp({ config, clients, logger: false });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: body,
    });
    return { statusCode: response.statusCode, calls };
  } finally {
    await app.close();
  }
}

const VALID = {
  email: 'someone@example.com',
  password: 'correct-horse-battery',
  timezone: 'Asia/Kolkata',
};

describe('POST /api/auth/register — email confirmation redirect', () => {
  it('tells Supabase where the confirmation link should land', async () => {
    const { statusCode, calls } = await register(VALID);

    expect(statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    // Without this, Supabase falls back to the project's Site URL, which
    // defaults to http://localhost:3000 — nobody's machine once deployed.
    expect(calls[0]?.options?.emailRedirectTo).toBe(
      'https://jambu.onrender.com/auth/confirmed',
    );
  });

  it('points at the page the API actually serves', async () => {
    const { calls } = await register(VALID);
    const target = calls[0]?.options?.emailRedirectTo ?? '';

    // The path must match the route registered in app.ts; a typo here is
    // invisible until a real confirmation email is opened.
    expect(new URL(target).pathname).toBe('/auth/confirmed');
    expect(new URL(target).protocol).toBe('https:');
  });

  it('serves that exact path', async () => {
    // Closes the loop: the redirect target resolves to a real 200, so the
    // constant and the route cannot drift apart.
    const { clients } = stubClients();
    const app = await buildApp({ config, clients, logger: false });
    const response = await app.inject({ method: 'GET', url: '/auth/confirmed' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('still passes the credentials through unchanged', async () => {
    const { calls } = await register(VALID);

    // The redirect is additive: it must not disturb what Supabase is being
    // asked to do (CLAUDE.md §24 — credentials pass straight through).
    expect(calls[0]?.email).toBe('someone@example.com');
    expect(calls[0]?.password).toBe('correct-horse-battery');
  });

  it('does not reach Supabase at all when the body is invalid', async () => {
    const { statusCode, calls } = await register({
      email: 'not-an-email',
      password: 'short',
    });

    expect(statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
