import { describe, expect, it } from 'vitest';

import {
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
} from './auth.js';

describe('registerRequestSchema', () => {
  it('accepts a valid registration', () => {
    const parsed = registerRequestSchema.parse({
      email: 'A@B.com',
      password: 'correct-horse',
      name: 'Dev',
      timezone: 'Asia/Kolkata',
    });
    expect(parsed.email).toBe('a@b.com');
    expect(parsed.timezone).toBe('Asia/Kolkata');
  });

  it('defaults timezone to UTC when omitted', () => {
    expect(
      registerRequestSchema.parse({ email: 'a@b.com', password: 'correct-horse' })
        .timezone,
    ).toBe('UTC');
  });

  it('rejects a weak or oversized password', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(73) })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid email', () => {
    for (const email of ['', 'a@', 'not-an-email', 'a b@c.com']) {
      expect(
        registerRequestSchema.safeParse({ email, password: 'correct-horse' }).success,
      ).toBe(false);
    }
  });

  it('rejects an invalid IANA timezone (CLAUDE.md §28)', () => {
    expect(
      registerRequestSchema.safeParse({
        email: 'a@b.com',
        password: 'correct-horse',
        timezone: 'Mars/Olympus',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    expect(
      registerRequestSchema.safeParse({
        email: 'a@b.com',
        password: 'correct-horse',
        isAdmin: true,
      }).success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts credentials and normalises the email', () => {
    expect(loginRequestSchema.parse({ email: ' A@B.COM ', password: 'x' }).email).toBe(
      'a@b.com',
    );
  });

  it('does not impose the registration password floor on login', () => {
    // An existing account may predate any policy change; rejecting here would
    // lock people out rather than telling them the password is wrong.
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.com', password: 'x' }).success,
    ).toBe(true);
  });

  it('requires both fields', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ password: 'x' }).success).toBe(false);
  });
});

describe('refreshRequestSchema', () => {
  it('requires a non-empty token', () => {
    expect(refreshRequestSchema.safeParse({ refreshToken: 'abc' }).success).toBe(true);
    expect(refreshRequestSchema.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(refreshRequestSchema.safeParse({}).success).toBe(false);
  });
});
