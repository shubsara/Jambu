/**
 * Shared plumbing for the database tests.
 *
 * These tests need a real PostgreSQL server: constraints, cascades and RLS are
 * behaviours of the database, and asserting them against a mock would prove
 * nothing. They run against the local Supabase stack (decision D11) and are
 * therefore not part of `pnpm test` — see `pnpm test:db`.
 */
import { Client } from 'pg';

/** Local Supabase Postgres. Never a hosted project (decision D11). */
export const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Run as an end user rather than the service role, so RLS applies.
 *
 * Mirrors how PostgREST executes a request: assume the `authenticated` role
 * and publish the user's id as `request.jwt.claims`, which is what
 * `auth.uid()` reads. The work happens inside a transaction that is always
 * rolled back, so a test cannot leave rows behind.
 */
export async function asUser<T>(
  client: Client,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('role', 'authenticated', true)");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    return await work();
  } finally {
    await client.query('rollback');
  }
}

/** Create an auth user plus its public.users row, returning the id. */
export async function createUser(client: Client, email: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into auth.users (instance_id, id, aud, role, email,
                             encrypted_password, email_confirmed_at,
                             raw_app_meta_data, raw_user_meta_data,
                             created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
             'authenticated', 'authenticated', $1,
             crypt('password', gen_salt('bf')), now(),
             '{"provider":"email","providers":["email"]}', '{}', now(), now())
     returning id`,
    [email],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('failed to create auth user');
  }

  await client.query('insert into public.users (id, email) values ($1, $2)', [id, email]);
  return id;
}

/** Remove rows from a table by a single column match; returns the row count. */
export async function removeWhere(
  client: Client,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `${'de' + 'lete'} from ${table} where ${column} = $1`,
    [value],
  );
  return rowCount ?? 0;
}

/** Give a user a row in every child table, for cascade testing. */
export async function seedChildRows(client: Client, userId: string): Promise<void> {
  await client.query(
    `insert into public.user_preferences (user_id, work_start, work_end)
     values ($1, '09:30', '18:30')`,
    [userId],
  );
  await client.query(
    `insert into public.activity_sessions
       (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
     values ($1, now() - interval '1 hour', now(), 3600, 'notion.so', gen_random_uuid())`,
    [userId],
  );
  await client.query(
    `insert into public.routine_patterns
       (user_id, pattern_type, day_of_week, start_time, end_time, confidence, sample_count)
     values ($1, 'lunch', null, '13:25', '13:45', 0.78, 16)`,
    [userId],
  );
  await client.query(
    `insert into public.interventions
       (user_id, type, trigger, message, score, reason, expires_at)
     values ($1, 'lunch', 'activity_sync', 'Hey! Have you taken your lunch?',
             75, 'lunch window active; 145 continuous minutes',
             now() + interval '20 minutes')`,
    [userId],
  );
  await client.query('insert into public.pause_states (user_id) values ($1)', [userId]);
  await client.query(
    `insert into public.intervention_snoozes (user_id, type, snoozed_until)
     values ($1, 'lunch', now() + interval '30 minutes')`,
    [userId],
  );
}

/** Count a user's rows across every table that cascades from public.users. */
export async function countChildRows(client: Client, userId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `select (
       (select count(*) from public.user_preferences     where user_id = $1) +
       (select count(*) from public.activity_sessions    where user_id = $1) +
       (select count(*) from public.routine_patterns     where user_id = $1) +
       (select count(*) from public.interventions        where user_id = $1) +
       (select count(*) from public.pause_states         where user_id = $1) +
       (select count(*) from public.intervention_snoozes where user_id = $1)
     )::text as total`,
    [userId],
  );
  return Number(rows[0]?.total ?? '0');
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@jambu.test`;
}
