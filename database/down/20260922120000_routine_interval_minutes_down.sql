-- Rollback for 20260922120000_routine_interval_minutes.sql.
alter table public.routine_patterns
  drop constraint if exists routine_patterns_interval_minutes_positive;
alter table public.routine_patterns
  drop constraint if exists routine_patterns_shape_is_coherent;
alter table public.routine_patterns
  drop column if exists interval_minutes;
