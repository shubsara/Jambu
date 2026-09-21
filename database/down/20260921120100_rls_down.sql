-- Rollback for 20260921120100_rls.sql.
drop policy if exists intervention_snoozes_own_rows on public.intervention_snoozes;
drop policy if exists pause_states_own_rows         on public.pause_states;
drop policy if exists interventions_own_rows        on public.interventions;
drop policy if exists routine_patterns_own_rows     on public.routine_patterns;
drop policy if exists activity_sessions_own_rows    on public.activity_sessions;
drop policy if exists user_preferences_own_rows     on public.user_preferences;
drop policy if exists users_own_row                 on public.users;

alter table public.deletion_requests    disable row level security;
alter table public.intervention_snoozes disable row level security;
alter table public.pause_states         disable row level security;
alter table public.interventions        disable row level security;
alter table public.routine_patterns     disable row level security;
alter table public.activity_sessions    disable row level security;
alter table public.user_preferences     disable row level security;
alter table public.users                disable row level security;
