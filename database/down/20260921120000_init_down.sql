-- Rollback for 20260921120000_init.sql.
-- Dropped in reverse dependency order. Indexes and constraints go with their
-- tables; public.users is dropped last because everything references it.
drop table if exists public.deletion_requests;
drop table if exists public.intervention_snoozes;
drop table if exists public.pause_states;
drop table if exists public.interventions;
drop table if exists public.routine_patterns;
drop table if exists public.activity_sessions;
drop table if exists public.user_preferences;
drop table if exists public.users;
