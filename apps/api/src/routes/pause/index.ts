/**
 * Pause routes (docs/API.md §9).
 *
 * Pausing is the control §42 requires and §14 already scores at `-100`, and
 * until now nothing could set it. These three routes are the whole of it:
 * pause, read, resume.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { pauseRequestSchema } from '../../schemas/control.js';
import { endPause, readPause, startPause } from '../../services/pause.js';

export interface PauseRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

export function registerPauseRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: PauseRouteOptions,
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

  app.get('/api/pause', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    return await reply.code(200).send(await readPause(clients.admin, userId, new Date()));
  });

  app.post('/api/pause', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    // An absent body is a valid request: it means "pause indefinitely".
    const parsed = pauseRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'The request body is invalid.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const until = parsed.data.until === undefined ? null : new Date(parsed.data.until);
    return await reply
      .code(200)
      .send(await startPause(clients.admin, userId, until, new Date()));
  });

  app.delete('/api/pause', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    return await reply.code(200).send(await endPause(clients.admin, userId, new Date()));
  });
}
