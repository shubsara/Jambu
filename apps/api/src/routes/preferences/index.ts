/**
 * Preference routes (docs/API.md §6).
 *
 * Two routes, no third. Onboarding completion rides `PUT` as an explicit flag
 * rather than getting an endpoint of its own (resolution A2), and the same
 * `PUT` is the only way to change `users.timezone` after signup (decision
 * D90) — §13 promises an overridable timezone and nothing else can deliver it.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { updatePreferencesSchema } from '../../schemas/preferences.js';
import { readPreferences, updatePreferences } from '../../services/preferences.js';

export interface PreferenceRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

export function registerPreferenceRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: PreferenceRouteOptions,
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

  app.get('/api/preferences', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    return await reply.code(200).send(await readPreferences(clients.admin, userId));
  });

  app.put('/api/preferences', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const parsed = updatePreferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'The request body is invalid.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    return await reply
      .code(200)
      .send(await updatePreferences(clients.admin, userId, parsed.data, new Date()));
  });
}
