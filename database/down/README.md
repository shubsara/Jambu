# Rollback scripts

One `*_down.sql` per forward migration in `../migrations`, applied in reverse
order to undo it.

These live outside `../migrations` on purpose. `supabase/migrations` is a
symlink to `../migrations`, and the Supabase CLI applies **every** file there
whose name matches `<timestamp>_name.sql`. A rollback script sitting in that
directory would be run as a forward migration and drop the schema it was
written to undo.

The Supabase CLI has no built-in down-migration command, so these are applied
directly with `psql`. `database/tests/migrations.test.ts` exercises them.
