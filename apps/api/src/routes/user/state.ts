/**
 * GET /api/user/state (docs/API.md §5).
 *
 * Read-only. Reads current facts, hands them to the pure derivation with an
 * explicit `now`, and returns the result. Nothing is stored: CLAUDE.md §12
 * says to avoid duplicating derived state, and a cached snapshot would be one
 * more thing that can disagree with the activity it came from.
 *
 * The response is never logged — it describes a person's working day.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { resolveTimeZone } from '../../lib/timezone.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { readUserStateFacts } from '../../services/user-state-repository.js';
import { deriveUserState } from '../../services/user-state.js';

export interface UserStateRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

export function registerUserStateRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: UserStateRouteOptions,
): void {
  app.get(
    '/api/user/state',
    {
      onRequest: options.authenticate,
      config: {
        rateLimit: {
          max: options.maxRequestsPerMinute,
          timeWindow: '1 minute',
          // Decision D29: reuses the activity budget, keyed per user.
          keyGenerator: (request: FastifyRequest) =>
            request.authenticatedUser?.id ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request.authenticatedUser);

      // The single clock read for this request. Everything downstream is pure.
      const now = new Date();

      const facts = await readUserStateFacts(clients.admin, userId, now);

      const state = deriveUserState({
        now,
        timeZone: resolveTimeZone(facts.timeZone),
        sessions: facts.sessions,
        learnedLunchWindow: facts.learnedLunchWindow,
        lastLunchConfirmation: facts.lastLunchConfirmation,
        lastInterventionAt: facts.lastInterventionAt,
        paused: facts.paused,
      });

      return await reply.code(200).send(state);
    },
  );
}
