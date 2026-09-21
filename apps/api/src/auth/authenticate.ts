/**
 * Bearer-token authentication.
 *
 * Verifies the JWT with Supabase and establishes the authenticated user id as
 * the authorization subject for the request. Routes never read an id from the
 * body or a path parameter (docs/ARCHITECTURE.md §4.2).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../errors.js';
import type { SupabaseClients } from '../plugins/supabase.js';
import { type AuthenticatedUser, bearerTokenFrom } from './authorize.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate`; absent on unauthenticated routes. */
    authenticatedUser?: AuthenticatedUser;
  }
}

export function buildAuthenticate(clients: SupabaseClients) {
  return async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = bearerTokenFrom(request.headers.authorization);
    if (token === null) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
    }

    const { data, error } = await clients.admin.auth.getUser(token);
    if (error !== null || data.user === null) {
      // The underlying reason is never surfaced: it distinguishes "expired"
      // from "forged", which is information an attacker can use.
      throw new ApiError('UNAUTHENTICATED', 'Authentication is required.');
    }

    request.authenticatedUser = { id: data.user.id };
  };
}
