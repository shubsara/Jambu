-- Rollback for 20260924120000_users_onboarding_completed_at.sql.
--
-- Dropping the column discards the A4 grandfathering along with every
-- completion recorded since. Re-applying the migration re-grandfathers
-- everyone, which is the safe direction: no one loses tracking they had.
alter table public.users
  drop column if exists onboarding_completed_at;
