/**
 * Auth routes (docs/API.md §3).
 *
 * The API proxies Supabase Auth so the extension never receives a Supabase key
 * of any kind (decision D2). No password is hashed, stored or compared here
 * (CLAUDE.md §24) — credentials pass straight through to Supabase and are
 * never logged.
 */
import type { FastifyInstance } from 'fastify';

import { ApiError, INVALID_CREDENTIALS_MESSAGE } from '../errors.js';
import type { SupabaseClients } from '../plugins/supabase.js';
import {
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
} from '../schemas/auth.js';
import {
  compensateFailedRegistration,
  createProfile,
  registrationFailure,
} from '../services/registration.js';

/**
 * Where the confirmation link in the sign-up email lands.
 *
 * Supplied explicitly because Supabase otherwise falls back to the project's
 * Site URL — `http://localhost:3000` by default, which is nobody's machine
 * once the API is deployed. The target is `GET /auth/confirmed`, a static page
 * that tells the user their account is ready and sends them back to the
 * extension to sign in.
 *
 * It is deliberately NOT a callback: confirming an email starts no session
 * (resolution A3), and the page reads nothing from the URL.
 */
const EMAIL_CONFIRMATION_REDIRECT = 'https://jambu.onrender.com/auth/confirmed';

interface SessionLike {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at?: number | undefined;
}

function tokenPayload(session: SessionLike): {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
} {
  const expiresAtSeconds = session.expires_at ?? Math.floor(Date.now() / 1000);
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

/**
 * Per-route rate limit.
 *
 * Far tighter than the global floor: without it `/api/auth/login` is a
 * credential-stuffing endpoint and `/api/auth/register` an account-spam one.
 */
function authRateLimit(max: number) {
  return { config: { rateLimit: { max, timeWindow: '1 minute' } } };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  clients: SupabaseClients,
  maxAttemptsPerMinute: number,
): void {
  const AUTH_RATE_LIMIT = authRateLimit(maxAttemptsPerMinute);
  // --- POST /api/auth/register ---------------------------------------------
  app.post('/api/auth/register', AUTH_RATE_LIMIT, async (request, reply) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'The request body is invalid.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    const input = parsed.data;

    const { data, error } = await clients.auth.auth.signUp({
      email: input.email,
      password: input.password,
      options: { emailRedirectTo: EMAIL_CONFIRMATION_REDIRECT },
    });

    // Supabase may return a user with no session when confirmations are on.
    if (error !== null || data.user === null) {
      throw registrationFailure();
    }
    const userId = data.user.id;

    try {
      const profile = await createProfile(clients.admin, {
        userId,
        email: input.email,
        name: input.name,
        timezone: input.timezone,
      });

      if (data.session === null) {
        // No session to hand back; the account exists and can be signed into.
        return await reply.code(201).send({ user: profile });
      }

      return await reply.code(201).send({
        user: profile,
        ...tokenPayload(data.session),
      });
    } catch (cause) {
      // Decision D18: leave no auth user stranded without a profile.
      const compensated = await compensateFailedRegistration(clients.admin, userId);
      request.log.error(
        { compensated },
        'registration failed after auth user creation; compensating delete attempted',
      );
      throw cause;
    }
  });

  // --- POST /api/auth/login ------------------------------------------------
  app.post('/api/auth/login', AUTH_RATE_LIMIT, async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'The request body is invalid.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const { data, error } = await clients.auth.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    // One message for every failure mode: a different response for "no such
    // user" would confirm which addresses are registered.
    if (error !== null || data.session === null || data.user === null) {
      throw new ApiError('UNAUTHENTICATED', INVALID_CREDENTIALS_MESSAGE);
    }

    const { data: profile } = await clients.admin
      .from('users')
      .select('id, email, name, timezone')
      .eq('id', data.user.id)
      .single();

    return await reply.code(200).send({
      user: profile ?? { id: data.user.id, email: parsed.data.email },
      ...tokenPayload(data.session),
    });
  });

  // --- POST /api/auth/refresh ----------------------------------------------
  app.post('/api/auth/refresh', AUTH_RATE_LIMIT, async (request, reply) => {
    const parsed = refreshRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'The request body is invalid.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const { data, error } = await clients.auth.auth.refreshSession({
      refresh_token: parsed.data.refreshToken,
    });

    if (error !== null || data.session === null) {
      throw new ApiError('UNAUTHENTICATED', 'The refresh token is invalid or expired.');
    }

    return await reply.code(200).send(tokenPayload(data.session));
  });
}
