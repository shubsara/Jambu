/**
 * Fastify application assembly.
 *
 * Exported separately from `server.ts` so tests can drive the app in-process
 * with `app.inject()` instead of binding a port.
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';
import { createSupabaseClients, type SupabaseClients } from './plugins/supabase.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';

/**
 * Log redaction (CLAUDE.md §31).
 *
 * Passwords, tokens and Authorization headers must never reach a log line.
 * Redaction is configured at the logger rather than left to the discipline of
 * whoever writes the next `log.info`.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.refreshToken',
  'res.headers["set-cookie"]',
  'accessToken',
  'refreshToken',
  'password',
  'access_token',
  'refresh_token',
  'apikey',
];

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly clients?: SupabaseClients;
  readonly logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const clients = options.clients ?? createSupabaseClients(config);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.nodeEnv === 'test' ? 'silent' : 'info',
            redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
          },
  });

  // --- CORS (decision D19) --------------------------------------------------
  // Strict allowlist. A request from an unlisted origin is refused; `*` is
  // rejected at configuration time.
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser callers send no Origin header.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      callback(null, config.allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // --- Rate limiting --------------------------------------------------------
  // Global floor; the auth routes tighten it below. Without this,
  // POST /api/auth/login is a credential-stuffing endpoint.
  // The plugin's own 429 is left alone and reshaped by the error handler
  // below, so the envelope in docs/API.md §1.1 has exactly one author.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // --- Error handling (docs/API.md §1.1) ------------------------------------
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      void reply.code(error.statusCode).send(error.toBody());
      return;
    }

    const status = error.statusCode ?? 500;

    if (status === 429) {
      void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      });
      return;
    }

    // Fastify raises 4xx for a body it could not parse or a media type it
    // does not accept. These are the client's mistake, so they are reported as
    // VALIDATION_FAILED — never as a 500 carrying a parser stack trace.
    if (status >= 400 && status < 500) {
      void reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request could not be read. Send a valid JSON body.',
        },
      });
      return;
    }

    // Anything else is logged server-side and reported as INTERNAL. Supabase
    // and Postgres messages name tables, constraints and rows; none of that
    // crosses the boundary (CLAUDE.md §31).
    request.log.error({ err: error }, 'unhandled error');
    void reply.code(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'The requested route does not exist.' },
    });
  });

  // --- Routes ---------------------------------------------------------------
  registerHealthRoute(app, config.version);

  // Auth routes carry their own, much tighter budget via per-route config.
  registerAuthRoutes(app, clients, config.authRateLimitMax);

  return app;
}
