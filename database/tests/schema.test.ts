/**
 * Schema shape, constraints and indexes (docs/ARCHITECTURE.md §11).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  countChildRows,
  createUser,
  removeWhere,
  seedChildRows,
  uniqueEmail,
} from './helpers.js';

let db: Client;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db.end();
});

async function columnDefault(table: string, column: string): Promise<string | null> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `select column_default from information_schema.columns
     where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows[0]?.column_default ?? null;
}

describe('tables', () => {
  it('creates exactly the eight approved tables', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'activity_sessions',
      'deletion_requests',
      'intervention_snoozes',
      'interventions',
      'pause_states',
      'routine_patterns',
      'user_preferences',
      'users',
    ]);
  });

  it('stores every timestamp as timestamptz in UTC (CLAUDE.md §28)', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type = 'timestamp without time zone'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('decision D5 — pause, snooze and deletion are separate concerns', () => {
  it('keeps pause and snooze state out of user_preferences', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'user_preferences'
       order by column_name`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).not.toContain('paused_until');
    expect(columns).not.toContain('snoozed_until');
    expect(columns).not.toContain('paused');
  });

  it('gives deletion_requests no foreign key, so the audit row outlives the account', async () => {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.table_constraints
       where table_schema = 'public' and table_name = 'deletion_requests'
         and constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('defaults', () => {
  it('defaults hydration_enabled to false (decision D7 opt-in)', async () => {
    expect(await columnDefault('user_preferences', 'hydration_enabled')).toBe('false');
  });

  it('defaults the other intervention types to enabled', async () => {
    expect(await columnDefault('user_preferences', 'lunch_enabled')).toBe('true');
    expect(await columnDefault('user_preferences', 'break_enabled')).toBe('true');
    expect(await columnDefault('user_preferences', 'end_day_enabled')).toBe('true');
  });

  it("defaults persona to 'mom' (decision D10)", async () => {
    expect(await columnDefault('user_preferences', 'persona')).toContain("'mom'");
    expect(await columnDefault('interventions', 'persona')).toContain("'mom'");
  });
});

describe('indexes (docs/ARCHITECTURE.md §11.9)', () => {
  it('creates only the approved explicit indexes', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and indexname like '%\\_idx'
       order by indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'activity_sessions_user_started_at_idx',
      'interventions_user_shown_at_idx',
      'interventions_user_type_created_at_idx',
    ]);
  });

  it('covers the remaining approved index paths via unique constraints, not duplicates', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public'
         and tablename in ('routine_patterns', 'intervention_snoozes')`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/routine_patterns.*user_id, pattern_type, day_of_week/s);
    expect(defs).toMatch(/intervention_snoozes.*user_id, .?type/s);
  });
});

describe('constraints', () => {
  let userId: string;

  beforeAll(async () => {
    userId = await createUser(db, uniqueEmail('constraints'));
  });

  afterAll(async () => {
    await removeWhere(db, 'auth.users', 'id', userId);
  });

  it('rejects negative active_seconds', async () => {
    await expect(
      db.query(
        `insert into public.activity_sessions
           (user_id, started_at, ended_at, active_seconds, client_session_id)
         values ($1, now(), now(), -1, gen_random_uuid())`,
        [userId],
      ),
    ).rejects.toThrow(/active_seconds_non_negative/);
  });

  it('rejects a session that ends before it starts', async () => {
    await expect(
      db.query(
        `insert into public.activity_sessions
           (user_id, started_at, ended_at, active_seconds, client_session_id)
         values ($1, now(), now() - interval '1 hour', 60, gen_random_uuid())`,
        [userId],
      ),
    ).rejects.toThrow(/ends_after_start/);
  });

  it('rejects an unknown intervention response', async () => {
    await expect(
      db.query(
        `insert into public.interventions
           (user_id, type, trigger, message, score, reason, expires_at, response, responded_at)
         values ($1, 'lunch', 'activity_sync', 'm', 70, 'r', now(), 'maybe', now())`,
        [userId],
      ),
    ).rejects.toThrow(/response_known/);
  });

  it('accepts all five approved responses (CLAUDE.md §18)', async () => {
    for (const response of ['confirmed', 'not_yet', 'snoozed', 'dismissed', 'expired']) {
      const { rowCount } = await db.query(
        `insert into public.interventions
           (user_id, type, trigger, message, score, reason, expires_at, response, responded_at)
         values ($1, 'lunch', 'activity_sync', 'm', 70, 'r', now(), $2, now())`,
        [userId, response],
      );
      expect(rowCount).toBe(1);
    }
    await removeWhere(db, 'public.interventions', 'user_id', userId);
  });

  it('rejects confidence outside 0-1', async () => {
    for (const bad of [-0.1, 1.1]) {
      await expect(
        db.query(
          `insert into public.routine_patterns (user_id, pattern_type, confidence)
           values ($1, 'lunch', $2)`,
          [userId, bad],
        ),
      ).rejects.toThrow(/confidence_range/);
    }
  });

  it('rejects an unknown pattern_type and an out-of-range day_of_week', async () => {
    await expect(
      db.query(
        `insert into public.routine_patterns (user_id, pattern_type) values ($1, 'dinner')`,
        [userId],
      ),
    ).rejects.toThrow(/routine_patterns_type_known/);

    await expect(
      db.query(
        `insert into public.routine_patterns (user_id, pattern_type, day_of_week)
         values ($1, 'lunch', 7)`,
        [userId],
      ),
    ).rejects.toThrow(/day_of_week_range/);
  });

  it('keeps response and responded_at consistent', async () => {
    await expect(
      db.query(
        `insert into public.interventions
           (user_id, type, trigger, message, score, reason, expires_at, response)
         values ($1, 'lunch', 'activity_sync', 'm', 70, 'r', now(), 'confirmed')`,
        [userId],
      ),
    ).rejects.toThrow(/responded_at_requires_response/);
  });
});

describe('duplicate client_session_id replay protection (CLAUDE.md §26)', () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    userId = await createUser(db, uniqueEmail('replay'));
    otherUserId = await createUser(db, uniqueEmail('replay-other'));
  });

  afterAll(async () => {
    await removeWhere(db, 'auth.users', 'id', userId);
    await removeWhere(db, 'auth.users', 'id', otherUserId);
  });

  it('rejects a replayed client_session_id for the same user', async () => {
    const { rows } = await db.query<{ client_session_id: string }>(
      `insert into public.activity_sessions
         (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
       values ($1, now() - interval '30 minutes', now(), 1800, 'notion.so', gen_random_uuid())
       returning client_session_id`,
      [userId],
    );
    const replayed = rows[0]?.client_session_id as string;

    await expect(
      db.query(
        `insert into public.activity_sessions
           (user_id, started_at, ended_at, active_seconds, domain, client_session_id)
         values ($1, now() - interval '30 minutes', now(), 1800, 'notion.so', $2)`,
        [userId, replayed],
      ),
    ).rejects.toThrow(/client_session_unique/);
  });

  it('scopes the guard per user, so two users may generate the same id', async () => {
    const shared = '22222222-2222-2222-2222-222222222222';
    for (const id of [userId, otherUserId]) {
      const { rowCount } = await db.query(
        `insert into public.activity_sessions
           (user_id, started_at, ended_at, active_seconds, client_session_id)
         values ($1, now() - interval '10 minutes', now(), 600, $2)`,
        [id, shared],
      );
      expect(rowCount).toBe(1);
    }
  });
});

describe('routine_patterns NULL uniqueness (decision D13)', () => {
  let userId: string;

  beforeAll(async () => {
    userId = await createUser(db, uniqueEmail('nulls'));
  });

  afterAll(async () => {
    await removeWhere(db, 'auth.users', 'id', userId);
  });

  it('treats NULL day_of_week as colliding with NULL, preventing duplicate all-day rows', async () => {
    await db.query(
      `insert into public.routine_patterns (user_id, pattern_type, day_of_week)
       values ($1, 'lunch', null)`,
      [userId],
    );

    await expect(
      db.query(
        `insert into public.routine_patterns (user_id, pattern_type, day_of_week)
         values ($1, 'lunch', null)`,
        [userId],
      ),
    ).rejects.toThrow(/unique_per_day/);
  });

  it('still allows the same pattern on distinct weekdays', async () => {
    for (const day of [0, 1, 2]) {
      const { rowCount } = await db.query(
        `insert into public.routine_patterns (user_id, pattern_type, day_of_week)
         values ($1, 'work_start', $2)`,
        [userId, day],
      );
      expect(rowCount).toBe(1);
    }
  });
});

describe('foreign key cascade', () => {
  it('removes every owned row when the account is deleted (CLAUDE.md §42)', async () => {
    const userId = await createUser(db, uniqueEmail('cascade'));
    await seedChildRows(db, userId);
    expect(await countChildRows(db, userId)).toBe(6);

    // Deleting the auth user cascades to public.users and onward.
    await removeWhere(db, 'auth.users', 'id', userId);

    expect(await countChildRows(db, userId)).toBe(0);
    const { rows } = await db.query(`select 1 from public.users where id = $1`, [userId]);
    expect(rows).toEqual([]);
  });

  it('keeps deletion_requests after the account is gone (decision D5)', async () => {
    const userId = await createUser(db, uniqueEmail('audit'));
    await db.query(
      `insert into public.deletion_requests (user_id, scope, status)
       values ($1, 'account', 'completed')`,
      [userId],
    );

    await removeWhere(db, 'auth.users', 'id', userId);

    const { rows } = await db.query<{ scope: string }>(
      `select scope from public.deletion_requests where user_id = $1`,
      [userId],
    );
    expect(rows[0]?.scope).toBe('account');
    await removeWhere(db, 'public.deletion_requests', 'user_id', userId);
  });

  it('nulls a snooze source rather than deleting the snooze when its intervention goes', async () => {
    const userId = await createUser(db, uniqueEmail('snooze-src'));
    const { rows } = await db.query<{ id: string }>(
      `insert into public.interventions
         (user_id, type, trigger, message, score, reason, expires_at)
       values ($1, 'lunch', 'activity_sync', 'm', 70, 'r', now() + interval '10 minutes')
       returning id`,
      [userId],
    );
    const interventionId = rows[0]?.id as string;

    await db.query(
      `insert into public.intervention_snoozes
         (user_id, type, snoozed_until, source_intervention_id)
       values ($1, 'lunch', now() + interval '30 minutes', $2)`,
      [userId, interventionId],
    );

    await removeWhere(db, 'public.interventions', 'id', interventionId);

    const { rows: after } = await db.query<{ source_intervention_id: string | null }>(
      `select source_intervention_id from public.intervention_snoozes where user_id = $1`,
      [userId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.source_intervention_id).toBeNull();

    await removeWhere(db, 'auth.users', 'id', userId);
  });
});
