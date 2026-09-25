-- Decision D86 / resolution A4 — onboarding completion becomes server state.
--
-- D93 gates activity tracking on onboarding completion: signing in is not
-- consent to be observed, finishing onboarding is. The extension therefore
-- needs to know whether onboarding is done, and it must survive a reinstall
-- and reach a second device — so the answer lives here, not in
-- `chrome.storage`.
alter table public.users
  add column onboarding_completed_at timestamptz;

comment on column public.users.onboarding_completed_at is
  'When the user finished onboarding (D86). NULL means not yet onboarded, and under D93 nothing is tracked until it is set. Existing users were grandfathered at migration time (A4).';

-- Resolution A4 — grandfather everyone who already exists.
--
-- Without this, adding the column would silently switch off tracking for every
-- P8-P11 beta account the moment P12 ships. Those users consented in the
-- pre-P12 world and a new column is not a reason to revoke it.
--
-- This runs exactly once, at migration time. Users registered afterwards get
-- NULL from the column default and must complete onboarding explicitly.
update public.users
  set onboarding_completed_at = now()
  where onboarding_completed_at is null;
