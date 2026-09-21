#!/usr/bin/env node
/**
 * Bundle secret scan (decision D2, P8 acceptance).
 *
 * Inspects the BUILT ARTEFACT, not the source. A scan over source would pass
 * while a key reached the bundle through an inlined env var or a transitive
 * import — which is precisely the failure worth catching.
 *
 * The extension talks only to the Jambu API, so no Supabase URL, anon key or
 * service-role key has any business being in it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'apps/extension/dist';

const FORBIDDEN = [
  { label: 'Supabase reference', pattern: /supabase/i },
  { label: 'service-role key', pattern: /service_role/i },
  { label: 'Supabase env var', pattern: /SUPABASE_/ },
  { label: 'JWT-shaped credential', pattern: /eyJ[A-Za-z0-9_-]{10,}/ },
  { label: 'Supabase secret key', pattern: /sb_secret_/ },
  { label: 'Supabase publishable key', pattern: /sb_publishable_/ },
];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`check:extension FAILED — no build output at ${DIST}.`);
  console.error('Run:  pnpm run build:extension');
  process.exit(1);
}

if (files.length === 0) {
  console.error(`check:extension FAILED — ${DIST} is empty.`);
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  for (const { label, pattern } of FORBIDDEN) {
    if (pattern.test(contents)) {
      failures.push(`${file}: contains a ${label}`);
    }
  }
}

// The manifest must ship, or the artefact is not an extension.
if (!files.some((file) => file.endsWith('manifest.json'))) {
  failures.push('manifest.json is missing from the build output');
}

if (failures.length > 0) {
  console.error('check:extension FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check:extension passed — ${files.length} built files, no Supabase credential present.`,
);
