/**
 * Routine routes (docs/API.md §7).
 *
 * `GET /api/routines` exposes a behavioural profile — when someone eats,
 * starts and stops work. That is sensitive even without a single domain in it,
 * so it is user-scoped, never logged, and carries nothing about what the user
 * was doing.
 */
import { tierFor } from '@jambu/routine-learning';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { recalculateRoutines } from '../../services/routine-learning.js';

export interface RoutineRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

interface StoredRoutineRow {
  readonly pattern_type: string;
  readonly day_of_week: number | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly interval_minutes: number | null;
  readonly confidence: number | string;
  readonly sample_count: number;
}

/** Shape a stored row for the client (docs/API.md §7). */
function toView(row: StoredRoutineRow) {
  const sampleCount = row.sample_count;

  return {
    type: row.pattern_type,
    dayOfWeek: row.day_of_week,
    start: row.start_time === null ? null : row.start_time.slice(0, 5),
    end: row.end_time === null ? null : row.end_time.slice(0, 5),
    // Decision D77: interval-shaped patterns report a duration, not a span.
    intervalMinutes: row.interval_minutes,
    confidence: Number(row.confidence),
    sampleCount,
    tier: tierFor(sampleCount),
  };
}

async function readRoutines(clients: SupabaseClients, userId: string) {
  const { data, error } = await clients.admin
    .from('routine_patterns')
    .select(
      'pattern_type, day_of_week, start_time, end_time, interval_minutes, confidence, sample_count',
    )
    .eq('user_id', userId)
    .order('pattern_type', { ascending: true });

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Routines could not be read.');
  }
  return ((data ?? []) as StoredRoutineRow[]).map(toView);
}

export function registerRoutineRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: RoutineRouteOptions,
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

  app.get('/api/routines', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);
    return await reply.code(200).send({ patterns: await readRoutines(clients, userId) });
  });

  app.post('/api/routines/recalculate', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    // Idempotent: the same activity always produces the same rows.
    await recalculateRoutines(clients.admin, userId, new Date());

    return await reply.code(200).send({ patterns: await readRoutines(clients, userId) });
  });
}
