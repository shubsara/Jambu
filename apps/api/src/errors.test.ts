import { describe, expect, it } from 'vitest';

import {
  ApiError,
  INVALID_CREDENTIALS_MESSAGE,
  REGISTRATION_CONFLICT_MESSAGE,
} from './errors.js';

describe('ApiError', () => {
  it('maps each code to the status in docs/API.md §1.1', () => {
    const expected: Record<string, number> = {
      VALIDATION_FAILED: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      INTERNAL: 500,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(new ApiError(code as never, 'm').statusCode).toBe(status);
    }
  });

  it('serialises to the documented envelope', () => {
    expect(new ApiError('VALIDATION_FAILED', 'bad', { field: 'email' }).toBody()).toEqual(
      {
        error: { code: 'VALIDATION_FAILED', message: 'bad', details: { field: 'email' } },
      },
    );
  });

  it('omits details when there are none, rather than sending undefined', () => {
    expect(new ApiError('INTERNAL', 'm').toBody()).toEqual({
      error: { code: 'INTERNAL', message: 'm' },
    });
  });
});

describe('messages that must not leak account existence', () => {
  it('uses one credential message regardless of which part was wrong', () => {
    expect(INVALID_CREDENTIALS_MESSAGE).toBe('Email or password is incorrect.');
    expect(INVALID_CREDENTIALS_MESSAGE).not.toMatch(/no such|not found|unknown user/i);
  });

  it('never says an email is already registered', () => {
    expect(REGISTRATION_CONFLICT_MESSAGE).not.toMatch(
      /already|exists|taken|registered user/i,
    );
  });
});
