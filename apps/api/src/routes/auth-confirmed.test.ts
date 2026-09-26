/**
 * GET /auth/confirmed.
 *
 * Runs in `pnpm verify` rather than the live API suite: the page touches no
 * database, so requiring Docker to test it would be a cost with no return.
 * The Supabase values below are placeholders that are never dialled — reaching
 * this route must not involve Supabase at all, and an unreachable URL is what
 * proves it.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'anon',
  supabaseServiceRoleKey: 'service-role',
  allowedOrigins: ['http://127.0.0.1:3000'],
  authRateLimitMax: 10_000,
  activityRateLimitMax: 10_000,
  interventionExpiryMinutes: 30,
  interventionSnoozeMinutes: 30,
  version: '9.9.9',
};

async function get(url = '/auth/confirmed') {
  const app = await buildApp({ config, logger: false });
  try {
    return await app.inject({ method: 'GET', url });
  } finally {
    await app.close();
  }
}

describe('GET /auth/confirmed', () => {
  it('answers 200 with HTML, unauthenticated', async () => {
    const response = await get();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
  });

  it('carries the confirmation copy', async () => {
    const { body } = await get();

    // The three lines the page exists to show. Asserted as text, so a styling
    // change is free and a copy change is a reviewed event.
    expect(body).toContain('Email confirmed');
    expect(body).toContain('Your Jambu account is ready.');
    expect(body).toContain('Return to the Jambu extension and sign in.');
  });

  it('is reachable without an Authorization header', async () => {
    // Registering it inside the authenticated tree would make the page useless:
    // it is opened from a mail client, which has no Jambu session.
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: 'GET', url: '/auth/confirmed' });
    expect(response.statusCode).toBe(200);
    expect(response.statusCode).not.toBe(401);
    await app.close();
  });

  /**
   * The privacy requirement, asserted as a property of the document.
   *
   * Supabase leaves `#access_token=...` on this URL. A page with no script
   * cannot read it, so this is the check that matters more than any assertion
   * about what the handler does with the fragment: there is no code to do
   * anything with it.
   */
  it('ships no JavaScript, so nothing can read the URL fragment', async () => {
    const response = await get();
    const { body } = response;

    // Status first: against a 404 body every assertion below would pass for
    // the wrong reason.
    expect(response.statusCode).toBe(200);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(body).not.toMatch(/javascript:/i);
    expect(body).not.toMatch(/location\.hash|access_token|refresh_token/i);
  });

  it('forbids script execution and referrer leakage by header', async () => {
    const { headers } = await get();

    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  it('is a dead end, not an auth callback', async () => {
    const response = await get();
    const { body } = response;

    expect(response.statusCode).toBe(200);

    // No form, and no link back into the API. Confirming an email does not
    // start a session (resolution A3); a "continue" control here would imply
    // it did.
    expect(body).not.toMatch(/<form/i);
    expect(body).not.toMatch(/\/api\//);
  });

  it('asks not to be indexed', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/name="robots"[^>]*noindex/i);
  });

  it('leaves the rest of the auth tree alone', async () => {
    // The new route sits next to `/api/auth/*`; it must not shadow it.
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

  it('does not answer a neighbouring path', async () => {
    const response = await get('/auth/confirmedx');
    expect(response.statusCode).toBe(404);
  });
});
