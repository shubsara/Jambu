/**
 * Migration application and reversibility.
 *
 * The "up" direction is proven by the fact that this suite can connect to a
 * database built by `supabase db reset` from an empty state — every other
 * assertion here rests on that. The "down" direction is exercised inside a
 * transaction that is always rolled back, so running the tests never leaves
 * the developer's database dismantled.
 *
 * The Supabase CLI has no down-migration command, so the rollback scripts in
 * database/down are applied directly. They deliberately live outside
 * database/migrations: supabase/migrations symlinks to that directory, and the
 * CLI would otherwise run them as forward migrations.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect } from './helpers.js';

let db: Client;

const MIGRATION_VERSIONS = ['20260921120000', '20260921120100'] as const;

const TABLES = [
  'activity_sessions',
  'deletion_requests',
  'intervention_snoozes',
  'interventions',
  'pause_states',
  'routine_patterns',
  'user_preferences',
  'users',
] as const;

function downScript(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../down/${name}`, import.meta.url)), 'utf8');
}

async function publicTableCount(client: Client): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `select count(*)::text as count from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db.end();
});

describe('up migration', () => {
  it('records both migrations as applied', async () => {
    const { rows } = await db.query<{ version: string }>(
      `select version from supabase_migrations.schema_migrations order by version`,
    );
    const versions = rows.map((r) => r.version);
    for (const expected of MIGRATION_VERSIONS) {
      expect(versions).toContain(expected);
    }
  });

  it('produced all eight tables from an empty database', async () => {
    expect(await publicTableCount(db)).toBe(8);
  });

  it('loaded the dev seed from database/seed (CLAUDE.md §7)', async () => {
    const { rows } = await db.query<{ email: string; timezone: string }>(
      `select email, timezone from public.users
       where id = '11111111-1111-1111-1111-111111111111'`,
    );
    expect(rows[0]?.email).toBe('dev@jambu.local');
    expect(rows[0]?.timezone).toBe('Asia/Kolkata');
  });

  it('applied the seed without overriding schema defaults', async () => {
    const { rows } = await db.query<{ hydration_enabled: boolean; persona: string }>(
      `select hydration_enabled, persona from public.user_preferences
       where user_id = '11111111-1111-1111-1111-111111111111'`,
    );
    expect(rows[0]?.hydration_enabled).toBe(false);
    expect(rows[0]?.persona).toBe('mom');
  });
});

describe('down migration', () => {
  it('reverses the RLS migration, leaving tables in place', async () => {
    await db.query('begin');
    try {
      await db.query(downScript('20260921120100_rls_down.sql'));

      const { rows: policies } = await db.query<{ count: string }>(
        `select count(*)::text as count from pg_policies where schemaname = 'public'`,
      );
      expect(policies[0]?.count).toBe('0');

      const { rows: secured } = await db.query<{ count: string }>(
        `select count(*)::text as count
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
      );
      expect(secured[0]?.count).toBe('0');

      // Reversing RLS must not touch the schema itself.
      expect(await publicTableCount(db)).toBe(8);
    } finally {
      await db.query('rollback');
    }
  });

  it('reverses the init migration, removing every table', async () => {
    await db.query('begin');
    try {
      await db.query(downScript('20260921120100_rls_down.sql'));
      await db.query(downScript('20260921120000_init_down.sql'));

      expect(await publicTableCount(db)).toBe(0);
    } finally {
      await db.query('rollback');
    }
  });

  it('is idempotent — running the rollback twice does not error', async () => {
    await db.query('begin');
    try {
      await db.query(downScript('20260921120100_rls_down.sql'));
      await db.query(downScript('20260921120000_init_down.sql'));
      await db.query(downScript('20260921120000_init_down.sql'));

      expect(await publicTableCount(db)).toBe(0);
    } finally {
      await db.query('rollback');
    }
  });

  it('leaves the database intact after the rollbacks are undone', async () => {
    expect(await publicTableCount(db)).toBe(8);

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from pg_policies where schemaname = 'public'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});

describe('rollback scripts stay out of the CLI migration path', () => {
  it('has one down script per forward migration', () => {
    expect(() => downScript('20260921120000_init_down.sql')).not.toThrow();
    expect(() => downScript('20260921120100_rls_down.sql')).not.toThrow();
  });

  it('drops every table the init migration creates', () => {
    const script = downScript('20260921120000_init_down.sql');
    for (const table of TABLES) {
      expect(script).toContain(`public.${table}`);
    }
  });
});
