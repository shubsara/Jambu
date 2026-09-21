-- Jambu initial schema.
--
-- Canonical location: database/migrations (CLAUDE.md §7).
-- The Supabase CLI reads it through the supabase/migrations symlink.
--
-- Design: docs/ARCHITECTURE.md §11. Rollback: database/down/.
--
-- Every timestamp is TIMESTAMPTZ stored in UTC (CLAUDE.md §28). Wall-clock
-- preferences are TIME and are always interpreted in the user's IANA timezone.
--
-- Enumerated values use VARCHAR + CHECK rather than Postgres ENUM types:
-- values can then be added or removed in an ordinary migration instead of
-- ALTER TYPE, and ENUM values cannot be dropped at all.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Mirrors the Supabase Auth user. Supabase owns credentials; this row holds
-- profile and timezone. `email` is replicated profile data owned by the
-- application (decision D14) and is removed by account deletion along with
-- everything else keyed to this row.
create table public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       varchar not null,
  name        varchar,
  timezone    varchar not null default 'UTC',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.users is
  'Application profile mirroring auth.users. Deleting the auth user cascades here.';
comment on column public.users.timezone is
  'IANA timezone, e.g. Asia/Kolkata. Never assume UTC for user-facing decisions (CLAUDE.md §28).';
comment on column public.users.deleted_at is
  'Soft-delete marker. Account deletion also hard-deletes all owned rows (CLAUDE.md §42).';

-- ---------------------------------------------------------------------------
-- user_preferences
-- ---------------------------------------------------------------------------
-- Stable user choices only. Pause and snooze are transient state and live in
-- their own tables (decision D5) — this table gains no state columns.
create table public.user_preferences (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.users (id) on delete cascade,
  work_start        time not null,
  work_end          time not null,
  lunch_enabled     boolean not null default true,
  break_enabled     boolean not null default true,
  hydration_enabled boolean not null default false,
  end_day_enabled   boolean not null default true,
  persona           varchar not null default 'mom',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.user_preferences.hydration_enabled is
  'Opt-in, defaults false (decision D7). Jambu asks about water; it never asserts a physical state.';
comment on column public.user_preferences.persona is
  'Resolved by the registry in @jambu/message-templates. MVP ships only "mom" (decision D10).';

-- ---------------------------------------------------------------------------
-- activity_sessions
-- ---------------------------------------------------------------------------
-- Aggregated slices of work. Privacy (CLAUDE.md §9): the registrable domain
-- only — never a path, query string or page title.
create table public.activity_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  started_at        timestamptz not null,
  ended_at          timestamptz not null,
  active_seconds    integer not null,
  domain            varchar,
  client_session_id uuid not null,
  created_at        timestamptz not null default now(),
  constraint activity_sessions_active_seconds_non_negative
    check (active_seconds >= 0),
  constraint activity_sessions_ends_after_start
    check (ended_at >= started_at),
  -- Makes ingestion idempotent. CLAUDE.md §26 requires the extension to buffer
  -- and retry when the API is down; without this a replayed batch would create
  -- duplicate rows and inflate continuous-work totals.
  constraint activity_sessions_client_session_unique
    unique (user_id, client_session_id)
);

comment on column public.activity_sessions.domain is
  'Registrable domain only, e.g. notion.so. Never a full URL (CLAUDE.md §9, §11).';

-- ---------------------------------------------------------------------------
-- routine_patterns
-- ---------------------------------------------------------------------------
create table public.routine_patterns (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  pattern_type varchar not null,
  day_of_week  integer,
  start_time   time,
  end_time     time,
  confidence   numeric(3, 2) not null default 0,
  sample_count integer not null default 0,
  updated_at   timestamptz not null default now(),
  constraint routine_patterns_type_known
    check (pattern_type in ('lunch', 'work_start', 'work_end', 'break_interval')),
  constraint routine_patterns_day_of_week_range
    check (day_of_week is null or day_of_week between 0 and 6),
  constraint routine_patterns_confidence_range
    check (confidence >= 0 and confidence <= 1),
  constraint routine_patterns_sample_count_non_negative
    check (sample_count >= 0),
  -- NULLS NOT DISTINCT is essential, not cosmetic. day_of_week IS NULL means
  -- "all days"; under Postgres' default NULLS DISTINCT this constraint would
  -- allow unlimited duplicate all-day rows for the same pattern type — exactly
  -- what it exists to prevent. Requires Postgres 15+; verified on 17.6.
  constraint routine_patterns_unique_per_day
    unique nulls not distinct (user_id, pattern_type, day_of_week)
);

comment on column public.routine_patterns.day_of_week is
  '0-6, or NULL meaning every day. Uniqueness uses NULLS NOT DISTINCT so NULL collides with NULL.';

-- ---------------------------------------------------------------------------
-- interventions
-- ---------------------------------------------------------------------------
create table public.interventions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  type         varchar not null,
  trigger      varchar not null,
  persona      varchar not null default 'mom',
  message      text not null,
  score        integer not null,
  reason       text not null,
  delivery     varchar,
  shown_at     timestamptz,
  expires_at   timestamptz not null,
  response     varchar,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint interventions_type_known
    check (type in ('lunch', 'break', 'hydration', 'end_of_day')),
  constraint interventions_trigger_known
    check (trigger in ('activity_sync', 'alarm_poll')),
  constraint interventions_delivery_known
    check (delivery is null or delivery in ('care_card', 'notification')),
  constraint interventions_response_known
    check (response is null or response in
      ('confirmed', 'not_yet', 'snoozed', 'dismissed', 'expired')),
  constraint interventions_responded_at_requires_response
    check ((response is null) = (responded_at is null))
);

comment on column public.interventions.score is
  'The score that produced this decision. CLAUDE.md §13 requires the engine be explainable, and §14 calls its weights starting points — tuning needs the arithmetic on every row.';
comment on column public.interventions.reason is
  'Human-readable explanation of the decision (CLAUDE.md §13).';

-- ---------------------------------------------------------------------------
-- pause_states (decision D5)
-- ---------------------------------------------------------------------------
-- Absence of a row means "not paused". A present row with pausedUntil NULL
-- means paused indefinitely — deliberately distinct from no row at all.
create table public.pause_states (
  user_id      uuid primary key references public.users (id) on delete cascade,
  paused_at    timestamptz not null default now(),
  paused_until timestamptz,
  source       varchar not null default 'user',
  updated_at   timestamptz not null default now(),
  constraint pause_states_source_known check (source in ('user', 'system'))
);

comment on table public.pause_states is
  'Backs the CLAUDE.md §14 "User paused Jambu -100" term and the §42 pause control.';

-- ---------------------------------------------------------------------------
-- intervention_snoozes (decision D5)
-- ---------------------------------------------------------------------------
-- Scoped to one intervention type, so snoozing lunch does not silence breaks.
create table public.intervention_snoozes (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.users (id) on delete cascade,
  type                   varchar not null,
  snoozed_until          timestamptz not null,
  source_intervention_id uuid references public.interventions (id) on delete set null,
  created_at             timestamptz not null default now(),
  constraint intervention_snoozes_type_known
    check (type in ('lunch', 'break', 'hydration', 'end_of_day')),
  constraint intervention_snoozes_unique_per_type
    unique (user_id, type)
);

-- ---------------------------------------------------------------------------
-- deletion_requests (decision D5)
-- ---------------------------------------------------------------------------
-- Auditable record that a deletion happened, holding no personal data.
-- user_id deliberately has NO foreign key: the audit row must outlive the
-- account it refers to, and it contains nothing but an opaque identifier.
create table public.deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  scope        varchar not null,
  status       varchar not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint deletion_requests_scope_known
    check (scope in ('activity', 'account')),
  constraint deletion_requests_status_known
    check (status in ('pending', 'completed', 'failed'))
);

comment on table public.deletion_requests is
  'Deletion audit trail. Intentionally has no FK to users so it survives account deletion (decision D5).';

-- ---------------------------------------------------------------------------
-- Indexes (docs/ARCHITECTURE.md §11.9)
-- ---------------------------------------------------------------------------
-- Only these. §11.9 also notes that primary keys and unique constraints supply
-- the rest: the index paths listed for routine_patterns (user_id, pattern_type,
-- day_of_week) and intervention_snoozes (user_id, type) are already provided by
-- the unique constraints above, so adding separate indexes would duplicate them
-- for nothing (CLAUDE.md §22: no excessive indexes).
create index activity_sessions_user_started_at_idx
  on public.activity_sessions (user_id, started_at desc);

create index interventions_user_shown_at_idx
  on public.interventions (user_id, shown_at desc);

create index interventions_user_type_created_at_idx
  on public.interventions (user_id, type, created_at desc);
