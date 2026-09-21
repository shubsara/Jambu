/**
 * The error envelope from docs/API.md §1.1.
 *
 * Every failure leaves the API through this type. Supabase and Postgres errors
 * are mapped here and never forwarded verbatim: an internal message can name a
 * table, a constraint or a row, and CLAUDE.md §31 forbids leaking it.
 */

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }

  public toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** The single message used for every failed credential check. */
export const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';

/**
 * The response to a registration attempt, whether or not the email is taken.
 *
 * Saying "that email is already registered" would let anyone test an address
 * against the user base, so registration conflicts and successes are
 * indistinguishable from outside (decision D18).
 */
export const REGISTRATION_CONFLICT_MESSAGE =
  'Registration could not be completed with the details provided.';
