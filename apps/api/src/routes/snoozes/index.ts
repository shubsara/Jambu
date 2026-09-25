/**
 * Snooze routes (docs/API.md §10; decision D102).
 *
 * **Two routes, not three.** §10 sketches a `POST /api/snoozes` "for the
 * settings UI", but D102 settled that snooze creation stays tied to an
 * intervention response: a snooze is a reaction to a card, not a schedule
 * someone sets in advance (CLAUDE.md §3.2). So there is nothing here that
 * mints one — only reading and clearing.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { snoozeTypeParamSchema } from '../../schemas/control.js';
import { clearSnooze, listActiveSnoozes } from '../../services/snooze.js';

export interface SnoozeRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

export function registerSnoozeRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: SnoozeRouteOptions,
): void {
  const guarded = {
    onRequest: options.authenticate,
    config: {
      rateLimit: {
        max: options.maxRequestsPerMinute,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) =>
          request.authenticatedUser?.id ?? request.ip,
      },
    },
  };

  app.get('/api/snoozes', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    return await reply
      .code(200)
      .send({ snoozes: await listActiveSnoozes(clients.admin, userId, new Date()) });
  });

  app.delete('/api/snoozes/:type', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const parsed = snoozeTypeParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'That is not an intervention type.');
    }

    // Idempotent: clearing a snooze that is not there is a success.
    await clearSnooze(clients.admin, userId, parsed.data.type);
    return await reply
      .code(200)
      .send({ snoozes: await listActiveSnoozes(clients.admin, userId, new Date()) });
  });
}
