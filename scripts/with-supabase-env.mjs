#!/usr/bin/env node
/**
 * Runs a command with the local Supabase stack's settings in the environment.
 *
 * The keys are read from `supabase status` at run time and injected into the
 * child process. Nothing is written to disk: the repository must never contain
 * a Supabase key, not even the well-known local-development ones, because a
 * committed key teaches the wrong habit and trips every secret scanner.
 */
import { spawn, spawnSync } from 'node:child_process';

const status = spawnSync('supabase', ['status', '-o', 'env'], {
  encoding: 'utf8',
  shell: false,
});

if (status.status !== 0) {
  console.error('Could not read the local Supabase status. Is the stack running?');
  console.error('Start it with:  pnpm db:start');
  process.exit(1);
}

const env = { ...process.env };
for (const line of status.stdout.split('\n')) {
  const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
  if (match === null) continue;
  const [, key, value] = match;
  if (key === 'API_URL') env['SUPABASE_URL'] = value;
  if (key === 'ANON_KEY') env['SUPABASE_ANON_KEY'] = value;
  if (key === 'SERVICE_ROLE_KEY') env['SUPABASE_SERVICE_ROLE_KEY'] = value;
  if (key === 'DB_URL') env['DATABASE_URL'] = value;
}

for (const required of [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]) {
  if (!env[required]) {
    console.error(`Missing ${required} from supabase status. Run: pnpm db:start`);
    process.exit(1);
  }
}

env['NODE_ENV'] = 'test';
env['CORS_ALLOWED_ORIGINS'] ??= 'http://127.0.0.1:3000';

const [command, ...args] = process.argv.slice(2);
spawn(command, args, { stdio: 'inherit', env, shell: false }).on('exit', (code) =>
  process.exit(code ?? 1),
);
