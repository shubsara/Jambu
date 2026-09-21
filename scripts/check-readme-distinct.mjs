#!/usr/bin/env node
/**
 * Guards the defect found during the P0 repository assessment: commit 467cc46
 * overwrote README.md with a verbatim copy of CLAUDE.md, so the public repo
 * front page showed internal agent instructions.
 *
 * CLAUDE.md is the internal Claude Code instruction file. README.md is the
 * project README. They must never be the same file again (decision D9).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const failures = [];

const readmeHash = sha('README.md');
const claudeHash = sha('CLAUDE.md');

if (readmeHash === claudeHash) {
  failures.push(
    'README.md is byte-identical to CLAUDE.md (regression of commit 467cc46).',
  );
}

const readme = readFileSync('README.md', 'utf8');
if (readme.includes('Claude Code Project Instructions')) {
  failures.push(
    'README.md contains CLAUDE.md heading text; it must not embed agent instructions.',
  );
}

if (failures.length > 0) {
  console.error('check:readme FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('check:readme passed — README.md and CLAUDE.md are distinct.');
