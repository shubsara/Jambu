/**
 * Environment configuration, validated once at startup.
 *
 * Security (CLAUDE.md §31, decision D2): the service-role key is read here and
 * never leaves the server. It is not logged, not echoed in a response, and
 * never reaches the extension bundle.
 */
import { z } from 'zod';

/**
 * Parses a comma-separated CORS allowlist.
 *
 * Decision D19: origins come from configuration. `*` is rejected outright —
 * an API holding user activity must not be callable from any page the user
 * happens to visit. The Chrome extension origin is added here once the
 * extension id exists (P8); it is deliberately not hard-coded now.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (origins.includes('*')) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must not contain "*" — list explicit origins (decision D19).',
    );
  }
  return origins;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  CORS_ALLOWED_ORIGINS: z.string().optional(),

  /** Requests per minute per IP on the auth routes. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /**
   * Requests per minute per user on activity ingest (decision D24).
   * Deliberately separate from the auth limit: the extension syncs often and
   * legitimately, and reusing the auth budget would break normal operation.
   */
  ACTIVITY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /** Decision D50 — how long a care card stays answerable. */
  INTERVENTION_EXPIRY_MINUTES: z.coerce.number().int().positive().default(30),

  /**
   * How long a "remind me later" silences that intervention type.
   *
   * NOT specified by CLAUDE.md or any approved decision — surfaced as D51 and
   * centralised here so it can be changed deliberately once ruled on.
   */
  INTERVENTION_SNOOZE_MINUTES: z.coerce.number().int().positive().default(30),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseServiceRoleKey: string;
  readonly allowedOrigins: readonly string[];
  readonly authRateLimitMax: number;
  readonly activityRateLimitMax: number;
  readonly interventionExpiryMinutes: number;
  readonly interventionSnoozeMinutes: number;
  readonly version: string;
}

/**
 * Build configuration from an environment.
 *
 * Throws on invalid input rather than starting a half-configured server. The
 * error names the missing variables but never their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }

  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    host: value.API_HOST,
    port: value.API_PORT,
    supabaseUrl: value.SUPABASE_URL,
    supabaseAnonKey: value.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: value.SUPABASE_SERVICE_ROLE_KEY,
    allowedOrigins: parseAllowedOrigins(value.CORS_ALLOWED_ORIGINS),
    authRateLimitMax: value.AUTH_RATE_LIMIT_MAX,
    activityRateLimitMax: value.ACTIVITY_RATE_LIMIT_MAX,
    interventionExpiryMinutes: value.INTERVENTION_EXPIRY_MINUTES,
    interventionSnoozeMinutes: value.INTERVENTION_SNOOZE_MINUTES,
    version: env['npm_package_version'] ?? '0.0.0',
  };
}
