/**
 * POST /api/activity/session (docs/API.md §4).
 *
 * Privacy: the request body is never logged. Activity is sensitive even when
 * reduced to domains, and the redaction configured in `app.ts` covers
 * credentials rather than bodies (CLAUDE.md §9, §31).
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import { activityBatchSchema } from '../../schemas/activity.js';
import { ingestSessions } from '../../services/activity.js';
import { createIfWarranted } from '../../services/intervention.js';

export interface ActivityRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly expiryMinutes: number;
  /** Runs before the rate limiter, so the limit can be keyed by user. */
  readonly authenticate: onRequestHookHandler;
}

export function registerActivityRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: ActivityRouteOptions,
): void {
  app.post(
    '/api/activity/session',
    {
      onRequest: options.authenticate,
      config: {
        rateLimit: {
          max: options.maxRequestsPerMinute,
          timeWindow: '1 minute',
          // Per user, not per IP (decision D24): several people behind one
          // office NAT must not exhaust each other's sync budget.
          keyGenerator: (request: FastifyRequest) =>
            request.authenticatedUser?.id ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request.authenticatedUser);

      const parsed = activityBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        // Only the field path and a fixed reason code are returned. The
        // submitted value is never echoed, so a leaked URL cannot reach the
        // response body or a log line (decision D23).
        throw new ApiError('VALIDATION_FAILED', 'The activity batch is invalid.', {
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
      }

      const result = await ingestSessions(clients.admin, userId, parsed.data.sessions);

      // Decision D4: the decision rides back on the ingest response, so the
      // common case needs no poll.
      //
      // Decision D49: activity ingestion is authoritative and already
      // committed. Everything below is a best-effort side effect — a failure
      // here must not make the extension retry a batch we accepted, because
      // that would trade a missed nudge for duplicated activity.
      let pendingInterventions: unknown[] = [];
      try {
        const outcome = await createIfWarranted(clients.admin, userId, new Date(), {
          expiryMinutes: options.expiryMinutes,
          trigger: 'activity_sync',
        });
        if (outcome.status === 'created' || outcome.status === 'existing') {
          pendingInterventions = [outcome.intervention];
        }
      } catch (cause) {
        // Structured, and deliberately narrow: no domains, URLs, page content,
        // tokens, or rendered message text (CLAUDE.md §9, §31).
        request.log.error(
          { event: 'intervention_decision_failed', stage: 'activity_sync' },
          'intervention decision failed after activity was accepted',
        );
        void cause;
      }

      return await reply.code(200).send({
        accepted: result.accepted,
        duplicates: result.duplicates,
        pendingInterventions,
      });
    },
  );
}
