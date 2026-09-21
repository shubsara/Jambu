/**
 * Authorization helper (decision D17).
 *
 * This is the control that protects user data: the API uses the service-role
 * key, which bypasses RLS, so these checks are the real boundary
 * (docs/ARCHITECTURE.md §4.3). The end-to-end user-A/user-B 403 lands with the
 * first resource route in P4.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../errors.js';
import {
  assertOwnership,
  bearerTokenFrom,
  ownsResource,
  requireUserId,
} from './authorize.js';

const ALICE = { id: 'aaaaaaaa-0000-0000-0000-000000000001' };
const BOB_RESOURCE = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('assertOwnership', () => {
  it('allows a user to reach their own resource', () => {
    expect(() => assertOwnership(ALICE, ALICE.id)).not.toThrow();
  });

  it("refuses another user's resource with 403, not 404 (docs/API.md §1.2)", () => {
    try {
      assertOwnership(ALICE, BOB_RESOURCE);
      throw new Error('expected assertOwnership to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('FORBIDDEN');
      expect((error as ApiError).statusCode).toBe(403);
    }
  });

  it('refuses an unauthenticated actor with 401', () => {
    expect(() => assertOwnership(undefined, ALICE.id)).toThrow(ApiError);
    try {
      assertOwnership(undefined, ALICE.id);
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(401);
    }
  });

  it('treats an empty id as unauthenticated rather than matching an empty owner', () => {
    try {
      assertOwnership({ id: '' }, '');
    } catch (error) {
      expect((error as ApiError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('reports a missing resource as 404 for an authenticated user', () => {
    for (const missing of [null, undefined]) {
      try {
        assertOwnership(ALICE, missing);
        throw new Error('expected assertOwnership to throw');
      } catch (error) {
        expect((error as ApiError).code).toBe('NOT_FOUND');
      }
    }
  });

  it('never leaks the owner id in the message', () => {
    try {
      assertOwnership(ALICE, BOB_RESOURCE);
    } catch (error) {
      expect((error as ApiError).message).not.toContain(BOB_RESOURCE);
      expect((error as ApiError).message).not.toContain(ALICE.id);
    }
  });
});

describe('ownsResource', () => {
  it('answers without throwing', () => {
    expect(ownsResource(ALICE, ALICE.id)).toBe(true);
    expect(ownsResource(ALICE, BOB_RESOURCE)).toBe(false);
    expect(ownsResource(undefined, ALICE.id)).toBe(false);
    expect(ownsResource(ALICE, null)).toBe(false);
  });
});

describe('requireUserId', () => {
  it('returns the authenticated id', () => {
    expect(requireUserId(ALICE)).toBe(ALICE.id);
  });

  it('refuses when unauthenticated, so a query can never run unscoped', () => {
    expect(() => requireUserId(undefined)).toThrow(ApiError);
    expect(() => requireUserId({ id: '' })).toThrow(ApiError);
  });
});

describe('bearerTokenFrom', () => {
  it('extracts a bearer token', () => {
    expect(bearerTokenFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerTokenFrom('  Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('rejects anything that is not a bearer token', () => {
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Basic abc',
      'bearerabc',
      'Token abc',
    ]) {
      expect(bearerTokenFrom(header)).toBeNull();
    }
  });

  it('is case-sensitive about the scheme, matching the documented contract', () => {
    expect(bearerTokenFrom('bearer abc')).toBeNull();
  });
});
