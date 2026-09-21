/**
 * Row Level Security, exercised with two separate users
 * (decision D2, docs/ARCHITECTURE.md §11.10).
 *
 * Read ARCHITECTURE.md §4.3 before trusting these results: the API connects
 * with the service-role key, which BYPASSES RLS. These policies are
 * defence-in-depth for future direct-client access, not the control that
 * protects data today. That control is the API's per-request authorisation,
 * asserted separately in P3.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asUser, connect, createUser, removeWhere, uniqueEmail } from './helpers.js';

let db: Client;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await connect();
  alice = await createUser(db, uniqueEmail('alice'));
  bob = await createUser(db, uniqueEmail('bob'));

  for (const id of [alice, bob]) {
    await db.query(
      `insert into public.user_preferences (user_id, work_start, work_end)
       values ($1, '09:30', '18:30')`,
      [id],
    );
    await db.query(
      `insert into public.activity_sessions
         (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
       values ($1, now() - interval '1 hour', now(), 3600, 'notion.so', gen_random_uuid())`,
      [id],
    );
    await db.query(
      `insert into public.interventions
         (user_id, type, trigger, message, score, reason, expires_at)
       values ($1, 'lunch', 'activity_sync', 'm', 75, 'r', now() + interval '20 minutes')`,
      [id],
    );
    await db.query('insert into public.pause_states (user_id) values ($1)', [id]);
    await db.query(
      `insert into public.intervention_snoozes (user_id, type, snoozed_until)
       values ($1, 'lunch', now() + interval '30 minutes')`,
      [id],
    );
    await db.query(
      `insert into public.routine_patterns (user_id, pattern_type, day_of_week)
       values ($1, 'lunch', null)`,
      [id],
    );
  }
});

afterAll(async () => {
  await removeWhere(db, 'auth.users', 'id', alice);
  await removeWhere(db, 'auth.users', 'id', bob);
  await db.end();
});

const USER_SCOPED_TABLES = [
  'user_preferences',
  'activity_sessions',
  'routine_patterns',
  'interventions',
  'pause_states',
  'intervention_snoozes',
] as const;

describe('RLS is enabled where the architecture says it is', () => {
  it('enables RLS on all eight tables, including deletion_requests', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('gives deletion_requests no policy, making it service-role only', async () => {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from pg_policies
       where schemaname = 'public' and tablename = 'deletion_requests'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('a user sees only their own rows', () => {
  for (const table of USER_SCOPED_TABLES) {
    it(`${table}: alice sees hers, not bob's`, async () => {
      const visible = await asUser(db, alice, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          `select user_id from public.${table}`,
        );
        return rows.map((r) => r.user_id);
      });

      expect(visible).toContain(alice);
      expect(visible).not.toContain(bob);
    });
  }

  it('users: alice sees only her own profile row', async () => {
    const visible = await asUser(db, alice, async () => {
      const { rows } = await db.query<{ id: string }>(`select id from public.users`);
      return rows.map((r) => r.id);
    });

    expect(visible).toEqual([alice]);
  });

  it('deletion_requests: an end user sees nothing at all', async () => {
    await db.query(
      `insert into public.deletion_requests (user_id, scope, status)
       values ($1, 'activity', 'completed')`,
      [alice],
    );

    const visible = await asUser(db, alice, async () => {
      const { rows } = await db.query(`select 1 from public.deletion_requests`);
      return rows;
    });

    expect(visible).toEqual([]);
    await removeWhere(db, 'public.deletion_requests', 'user_id', alice);
  });
});

describe('a user cannot write into another user', () => {
  it('rejects inserting a row owned by bob while acting as alice', async () => {
    await expect(
      asUser(db, alice, () =>
        db.query(
          `insert into public.activity_sessions
             (user_id, started_at, ended_at, active_seconds, client_session_id)
           values ($1, now() - interval '5 minutes', now(), 300, gen_random_uuid())`,
          [bob],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update bob's rows while acting as alice", async () => {
    const changed = await asUser(db, alice, async () => {
      const { rowCount } = await db.query(
        `update public.user_preferences set hydration_enabled = true where user_id = $1`,
        [bob],
      );
      return rowCount;
    });

    expect(changed).toBe(0);
  });

  it("cannot remove bob's rows while acting as alice", async () => {
    const removed = await asUser(db, alice, () =>
      removeWhere(db, 'public.intervention_snoozes', 'user_id', bob),
    );

    expect(removed).toBe(0);
  });

  it("leaves bob's data intact after all of the above", async () => {
    const { rows } = await db.query<{ hydration_enabled: boolean }>(
      `select hydration_enabled from public.user_preferences where user_id = $1`,
      [bob],
    );
    expect(rows[0]?.hydration_enabled).toBe(false);

    const { rows: snoozes } = await db.query(
      `select 1 from public.intervention_snoozes where user_id = $1`,
      [bob],
    );
    expect(snoozes).toHaveLength(1);
  });
});

describe('the service role bypasses RLS, which is why the API must authorise (ARCHITECTURE.md §4.3)', () => {
  it('sees every user when connected as the owner role', async () => {
    const { rows } = await db.query<{ id: string }>(`select id from public.users`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(alice);
    expect(ids).toContain(bob);
  });
});
