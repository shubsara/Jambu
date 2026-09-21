/**
 * Authorization primitives.
 *
 * This is the control that actually protects user data. The API connects to
 * Postgres with the service-role key, which BYPASSES Row Level Security
 * (docs/ARCHITECTURE.md §4.3), so RLS is defence-in-depth and these checks are
 * the real boundary (CLAUDE.md §31: "authorize every resource by user ID").
 *
 * Pure and dependency-free so it can be unit-tested exhaustively (decision
 * D17); the end-to-end 403 test arrives with the first user-scoped resource
 * route in P4.
 */
import { ApiError } from '../errors.js';

/** The authenticated subject of a request. */
export interface AuthenticatedUser {
  readonly id: string;
}

/**
 * Assert that the authenticated user owns the resource.
 *
 * Returns 403 rather than 404 when the owner differs: docs/API.md §1.2
 * requires "403, never 404-by-accident", so authorization failures are never
 * silently reported as missing resources.
 */
export function assertOwnership(
  actor: AuthenticatedUser | undefined,
  resourceOwnerId: string | null | undefined,
): void {
  if (actor === undefined || actor.id.length === 0) {
    throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  }

  if (resourceOwnerId === null || resourceOwnerId === undefined) {
    throw new ApiError('NOT_FOUND', 'The requested resource does not exist.');
  }

  if (resourceOwnerId !== actor.id) {
    throw new ApiError('FORBIDDEN', 'You do not have access to this resource.');
  }
}

/** Whether the actor owns the resource, without throwing. */
export function ownsResource(
  actor: AuthenticatedUser | undefined,
  resourceOwnerId: string | null | undefined,
): boolean {
  try {
    assertOwnership(actor, resourceOwnerId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The user id every user-scoped query must be filtered by.
 *
 * Routes call this instead of reading an id from the request body or a path
 * parameter, so a client cannot nominate whose data it is asking for.
 */
export function requireUserId(actor: AuthenticatedUser | undefined): string {
  if (actor === undefined || actor.id.length === 0) {
    throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
  }
  return actor.id;
}

/** Extract a bearer token from an Authorization header. */
export function bearerTokenFrom(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? null : token;
}
