/**
 * Domain normalisation and the privacy boundary (decisions D22, D23).
 *
 * CLAUDE.md §9: Jambu knows how long the user worked, not what they worked on.
 * These cases are the guard that makes that true in practice.
 */
import { describe, expect, it } from 'vitest';

import { normalizeDomain } from './domain.js';

function accepted(input: string): string {
  const result = normalizeDomain(input);
  if (!result.ok)
    throw new Error(`expected "${input}" to be accepted, got ${result.reason}`);
  return result.domain;
}

function rejected(input: string): string {
  const result = normalizeDomain(input);
  if (result.ok)
    throw new Error(`expected "${input}" to be rejected, got ${result.domain}`);
  return result.reason;
}

describe('accepted hostnames (decision D22)', () => {
  it('accepts a plain hostname', () => {
    expect(accepted('notion.so')).toBe('notion.so');
  });

  it('lowercases', () => {
    expect(accepted('NOTION.SO')).toBe('notion.so');
    expect(accepted('MaIl.GooGle.com')).toBe('mail.google.com');
  });

  it('drops a trailing dot, so the FQDN form is not a second domain', () => {
    expect(accepted('notion.so.')).toBe('notion.so');
  });

  it('trims surrounding whitespace', () => {
    expect(accepted('  notion.so  ')).toBe('notion.so');
  });

  it('keeps subdomains rather than guessing a registrable domain', () => {
    // D22: no Public Suffix List, and no naive last-two-labels heuristic.
    expect(accepted('www.notion.so')).toBe('www.notion.so');
    expect(accepted('foo.co.uk')).toBe('foo.co.uk');
    expect(accepted('user.github.io')).toBe('user.github.io');
    expect(accepted('a.b.c.d.example.com')).toBe('a.b.c.d.example.com');
  });

  it('accepts punycode, so internationalised domains survive', () => {
    expect(accepted('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  it('accepts a single-label host and hyphens inside labels', () => {
    expect(accepted('localhost')).toBe('localhost');
    expect(accepted('my-app.example.com')).toBe('my-app.example.com');
  });
});

describe('rejected values (decision D23 — reject, never strip)', () => {
  it('rejects a full URL', () => {
    expect(rejected('https://notion.so/page')).toBe('contains_scheme');
    expect(rejected('http://notion.so')).toBe('contains_scheme');
  });

  it('rejects a path', () => {
    expect(rejected('notion.so/private-doc')).toBe('contains_path');
    expect(rejected('notion.so/')).toBe('contains_path');
  });

  it('rejects a query string', () => {
    expect(rejected('notion.so?q=salary+negotiation')).toBe('contains_query');
  });

  it('rejects a fragment', () => {
    expect(rejected('notion.so#section-2')).toBe('contains_fragment');
  });

  it('rejects embedded credentials', () => {
    expect(rejected('user:pass@notion.so')).toBe('contains_scheme');
    expect(rejected('user@notion.so')).toBe('contains_credentials');
  });

  it('rejects a port, a common sign a URL was pasted in', () => {
    expect(rejected('notion.so:443')).toBe('contains_port');
  });

  it('rejects whitespace inside the value', () => {
    expect(rejected('notion so')).toBe('contains_whitespace');
  });

  it('rejects empty input', () => {
    expect(rejected('')).toBe('empty');
    expect(rejected('   ')).toBe('empty');
    expect(rejected('.')).toBe('empty');
  });

  it('rejects malformed hostnames', () => {
    for (const bad of ['-notion.so', 'notion-.so', 'notion..so', 'notion.so-', '..']) {
      expect(rejected(bad)).toBe('invalid_hostname');
    }
  });

  it('rejects an over-long hostname', () => {
    expect(rejected(`${'a'.repeat(64)}.example.com`)).toBe('invalid_hostname');
    expect(rejected(`${'a.'.repeat(200)}example.com`)).toBe('too_long');
  });

  it('never echoes the submitted value in the rejection reason', () => {
    const secret = 'notion.so/q?token=super-secret-value';
    const result = normalizeDomain(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('secret');
      expect(result.reason).not.toContain('notion');
      expect(JSON.stringify(result)).not.toContain('super-secret-value');
    }
  });
});
