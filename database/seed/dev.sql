-- Development seed (CLAUDE.md §7). Local use only — never run against a
-- hosted project. Loaded by `supabase db reset` via db.seed.sql_paths in
-- supabase/config.toml, which points here rather than duplicating the file.
--
-- Contains no real personal data: one fixed dev identity with a fixed UUID so
-- tests and manual checks can rely on it.

-- The auth user must exist first: public.users references auth.users(id).
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated', 'dev@jambu.local',
  crypt('devpassword', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  now(), now()
)
on conflict (id) do nothing;

insert into public.users (id, email, name, timezone)
values (
  '11111111-1111-1111-1111-111111111111',
  'dev@jambu.local',
  'Dev User',
  'Asia/Kolkata'
)
on conflict (id) do nothing;

-- Defaults mirror the schema: hydration off (D7), persona mom (D10).
insert into public.user_preferences (user_id, work_start, work_end)
values ('11111111-1111-1111-1111-111111111111', '09:30', '18:30')
on conflict (user_id) do nothing;
