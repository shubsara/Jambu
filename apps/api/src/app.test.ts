/**
 * Application-level behaviour that needs no Supabase: redaction config, CORS,
 * error envelope and the not-found handler.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED_LOG_PATHS, buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'anon',
  supabaseServiceRoleKey: 'service-role',
  allowedOrigins: ['http://127.0.0.1:3000'],
  version: '9.9.9',
};

describe('log redaction (CLAUDE.md §31)', () => {
  it('redacts credentials, tokens and the Authorization header', () => {
    for (const path of [
      'req.headers.authorization',
      'req.body.password',
      'req.body.refreshToken',
      'accessToken',
      'refreshToken',
      'password',
    ]) {
      expect(REDACTED_LOG_PATHS).toContain(path);
    }
  });
});

describe('health route', () => {
  it('reports status and version without authentication', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '9.9.9' });
    await app.close();
  });

  it('exposes no dependency detail', async () => {
    const app = await buildApp({ config, logger: false });
    const body = await app.inject({ method: 'GET', url: '/health' });
    expect(Object.keys(body.json())).toEqual(['status', 'version']);
    await app.close();
  });
});

describe('CORS (decision D19)', () => {
  it('allows a configured origin', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    await app.close();
  });

  it('refuses an unlisted origin', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('never answers with a wildcard', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    await app.close();
  });
});

describe('error envelope', () => {
  it('returns the documented shape for an unknown route', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'The requested route does not exist.' },
    });
    await app.close();
  });

  it('rejects a malformed body with VALIDATION_FAILED, not a stack trace', async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.json())).not.toMatch(
      /at Object|node_modules|SyntaxError/,
    );
    await app.close();
  });

  it('validates input before contacting Supabase', async () => {
    // Unreachable Supabase URL: a 400 proves validation rejected the request
    // without a network call.
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });
});
