import { describe, expect, it } from 'vitest';

import { loadConfig, parseAllowedOrigins } from './config.js';

const BASE = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

describe('parseAllowedOrigins (decision D19)', () => {
  it('parses an explicit allowlist', () => {
    expect(parseAllowedOrigins('http://127.0.0.1:3000, http://localhost:3000')).toEqual([
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ]);
  });

  it('treats an unset or empty value as allowing nothing', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('  ,  ')).toEqual([]);
  });

  it('refuses a wildcard outright', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/must not contain/);
    expect(() => parseAllowedOrigins('http://localhost:3000,*')).toThrow(
      /must not contain/,
    );
  });

  it('accepts a chrome-extension origin once one is configured', () => {
    expect(parseAllowedOrigins('chrome-extension://abcdefghijklmnop')).toEqual([
      'chrome-extension://abcdefghijklmnop',
    ]);
  });
});

describe('loadConfig', () => {
  it('requires the Supabase settings', () => {
    expect(() => loadConfig({})).toThrow(/Invalid environment configuration/);
  });

  it('names the missing fields but never their values', () => {
    try {
      loadConfig({ ...BASE, SUPABASE_URL: 'not-a-url' });
    } catch (error) {
      expect((error as Error).message).toContain('SUPABASE_URL');
      expect((error as Error).message).not.toContain('not-a-url');
    }
  });

  it('applies safe defaults for host, port and environment', () => {
    const config = loadConfig(BASE);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.allowedOrigins).toEqual([]);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...BASE, API_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...BASE, API_PORT: '0' })).toThrow();
  });

  it('keeps the service-role key available server-side', () => {
    expect(loadConfig(BASE).supabaseServiceRoleKey).toBe('service-role-key');
  });
});
