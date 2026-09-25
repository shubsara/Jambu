/**
 * Centralised request schemas (decision D16).
 *
 * Every route validates its input against a schema here (CLAUDE.md §31), and
 * the request types are inferred from the same declaration so validation and
 * types cannot drift apart.
 */
import { z } from 'zod';

/**
 * Password rules are a floor, not a policy: Supabase Auth owns credential
 * handling (CLAUDE.md §24). We reject obviously-unusable input before
 * spending a network call on it.
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be at most 72 characters.');

const email = z.string().trim().toLowerCase().email('A valid email is required.');

/**
 * IANA timezone, validated against the runtime's own database rather than a
 * hand-maintained list (CLAUDE.md §28).
 */
export const timezone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'A valid IANA timezone is required, for example Asia/Kolkata.');

export const registerRequestSchema = z
  .object({
    email,
    password,
    name: z.string().trim().min(1).max(100).optional(),
    timezone: timezone.default('UTC'),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    email,
    password: z.string().min(1, 'Password is required.'),
  })
  .strict();

export const refreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1, 'A refresh token is required.'),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
