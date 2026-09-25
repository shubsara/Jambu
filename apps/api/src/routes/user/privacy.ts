/**
 * Export and deletion routes (docs/API.md §11; decisions D104, D105, D106).
 *
 * These are the §42 promises that had no endpoint: take my data, and delete
 * it. Both deletions are irreversible, so both demand a typed confirmation
 * (D106) and both answer `202` with a request to poll rather than pretending
 * the work is already done (D104).
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

import { requireUserId } from '../../auth/authorize.js';
import { ApiError } from '../../errors.js';
import type { SupabaseClients } from '../../plugins/supabase.js';
import {
  confirmAccountDeletionSchema,
  confirmActivityDeletionSchema,
  deletionRequestIdParamSchema,
} from '../../schemas/control.js';
import { readDeletionRequest, requestDeletion } from '../../services/deletion.js';
import { buildExport } from '../../services/export.js';

export interface PrivacyRouteOptions {
  readonly maxRequestsPerMinute: number;
  readonly authenticate: onRequestHookHandler;
}

const IRREVERSIBLE =
  'This cannot be undone. Poll the deletion request to confirm it finished.';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  options: PrivacyRouteOptions,
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

  app.get('/api/user/export', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    // Never logged: this is the largest disclosure Jambu makes, and a log line
    // would quietly make a second copy of it (CLAUDE.md §31).
    return await reply
      .code(200)
      .send(await buildExport(clients.admin, userId, new Date()));
  });

  app.delete('/api/user/activity', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const parsed = confirmActivityDeletionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Type DELETE_ACTIVITY exactly to confirm this deletion.',
      );
    }

    const created = await requestDeletion(
      clients.admin,
      userId,
      'activity',
      new Date(),
      () => {
        request.log.error(
          { event: 'deletion_failed', scope: 'activity' },
          'activity deletion failed after the request was accepted',
        );
      },
    );

    return await reply.code(202).send({
      deletionRequestId: created.id,
      scope: created.scope,
      status: created.status,
      message: IRREVERSIBLE,
    });
  });

  app.delete('/api/user/account', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const parsed = confirmAccountDeletionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Type DELETE_ACCOUNT exactly to confirm this deletion.',
      );
    }

    const created = await requestDeletion(
      clients.admin,
      userId,
      'account',
      new Date(),
      () => {
        request.log.error(
          { event: 'deletion_failed', scope: 'account' },
          'account deletion failed after the request was accepted',
        );
      },
    );

    return await reply.code(202).send({
      deletionRequestId: created.id,
      scope: created.scope,
      status: created.status,
      message: IRREVERSIBLE,
    });
  });

  app.get('/api/user/deletion-request/:id', guarded, async (request, reply) => {
    const userId = requireUserId(request.authenticatedUser);

    const parsed = deletionRequestIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'That is not a deletion request id.');
    }

    const found = await readDeletionRequest(clients.admin, userId, parsed.data.id);
    if (found === null) {
      throw new ApiError('NOT_FOUND', 'No such deletion request.');
    }
    return await reply.code(200).send(found);
  });
}
