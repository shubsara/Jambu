-- Row Level Security (decision D2, docs/ARCHITECTURE.md §11.10).
--
-- IMPORTANT, and documented in ARCHITECTURE.md §4.3: the API connects with the
-- Supabase service-role key, which BYPASSES RLS. These policies are
-- defence-in-depth for any future direct-client access. The control that
-- actually protects data today is the API's per-request authorisation, which
-- scopes every query by the authenticated user id (CLAUDE.md §31), and P3
-- asserts cross-user access returns 403 independently of RLS.

-- ---------------------------------------------------------------------------
-- Enable RLS on every user-scoped table.
-- ---------------------------------------------------------------------------
alter table public.users                enable row level security;
alter table public.user_preferences     enable row level security;
alter table public.activity_sessions    enable row level security;
alter table public.routine_patterns     enable row level security;
alter table public.interventions        enable row level security;
alter table public.pause_states         enable row level security;
alter table public.intervention_snoozes enable row level security;

-- deletion_requests is service-role only: RLS is enabled and NO policy is
-- created, so no end-user role can read or write it. Only the service role,
-- which bypasses RLS, can touch the audit trail.
alter table public.deletion_requests    enable row level security;

-- ---------------------------------------------------------------------------
-- Policies: a user may only reach their own rows.
-- ---------------------------------------------------------------------------
-- public.users is keyed by `id` rather than `user_id`.
create policy users_own_row on public.users
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy user_preferences_own_rows on public.user_preferences
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy activity_sessions_own_rows on public.activity_sessions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy routine_patterns_own_rows on public.routine_patterns
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy interventions_own_rows on public.interventions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy pause_states_own_rows on public.pause_states
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy intervention_snoozes_own_rows on public.intervention_snoozes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
