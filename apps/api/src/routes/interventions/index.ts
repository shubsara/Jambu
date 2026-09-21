/**
 * Intervention routes (docs/API.md §8).
 *
 * The server is authoritative throughout: it builds the context, calls the
 * Care Engine, renders the message and sets the expiry. A client supplies only
 * its own answer.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import { resolveTimeZone, startOfLocalDay } from '../../lib/timezone.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import {
  interventionIdSchema,
  interventionResponseSchema,
} from '../../schemas/intervention.js';
import {
  createIfWarranted,
  expireStale,
  listForDay,
  recordResponse,
} from '../../services/intervention.js';

export interface InterventionRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly expiryMinutes: number;
  readonly snoozeMinutes: number;
  readonly authenticate: onRequestHookHandler;
}

export function registerInterventionRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: InterventionRouteOptions,
): void {
  // Decision D47: the same per-user budget as activity and state. No new knob.
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

  // --- POST /api/interventions ---------------------------------------------
  app.post('/api/interventions', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    const now = new Date();

    const outcome = await createIfWarranted(clients.admin, userId, now, {
      expiryMinutes: options.expiryMinutes,
      trigger: 'alarm_poll',
    });

    switch (outcome.status) {
      case 'created':
      case 'existing':
        return await reply.code(200).send(outcome.intervention);
      case 'declined':
        // The engine considered it and said no — not a conflict (decision D45).
        return await reply.code(204).send();
      case 'suppressed':
        throw new ApiError('CONFLICT', 'An intervention cannot be created right now.');
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  });

  // --- POST /api/interventions/:id/response --------------------------------
  app.post('/api/interventions/:id/response', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const params = interventionIdSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApiError('VALIDATION_FAILED', 'An intervention id is required.');
    }

    const body = interventionResponseSchema.safeParse(request.body);
    if (!body.success) {
      throw new ApiError('VALIDATION_FAILED', 'The response is invalid.', {
        fields: body.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const respondedAt =
      body.data.respondedAt === undefined ? new Date() : new Date(body.data.respondedAt);

    const outcome = await recordResponse(
      clients.admin,
      userId,
      params.data.id,
      body.data.response,
      respondedAt,
      options.snoozeMinutes,
    );

    // Both outcomes are 200: a repeat submission is the care card retrying,
    // not an error, and it returns the answer that was stored first.
    return await reply.code(200).send(outcome.intervention);
  });

  // --- GET /api/interventions/today ----------------------------------------
  app.get('/api/interventions/today', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    const now = new Date();

    // Lazy expiry (decision D50): no scheduler is introduced.
    await expireStale(clients.admin, userId, now);

    const { data } = await clients.admin
      .from('users')
      .select('timezone')
      .eq('id', userId)
      .maybeSingle();

    const timeZone = resolveTimeZone((data as { timezone: string } | null)?.timezone);
    const interventions = await listForDay(
      clients.admin,
      userId,
      startOfLocalDay(now, timeZone),
    );

    return await reply.code(200).send({ interventions });
  });
}
