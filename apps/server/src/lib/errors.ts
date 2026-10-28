import type { ApiError } from '@trf/shared';
import { MESSAGES } from '@trf/shared';

/**
 * The only error type that reaches the client. Anything else is logged on the
 * server and replaced with a generic message, so SQL and stack traces stay internal.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}) } };
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new AppError(400, 'BAD_REQUEST', message, fields);
export const unauthorized = (message: string = MESSAGES.INVALID_CREDENTIALS) => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message: string = MESSAGES.NO_PERMISSION) => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message: string = MESSAGES.NOT_FOUND) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const versionConflict = () => new AppError(409, 'VERSION_CONFLICT', MESSAGES.CONFLICT);

/** PostgreSQL unique violation (23505). The constraint name identifies which duplicate it was. */
export function duplicateError(err: unknown, friendlyByConstraint: Record<string, string> = {}): AppError | null {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== '23505') return null;
  const friendly = friendlyByConstraint[e.constraint ?? ''] ?? 'This record already exists.';
  return conflict(friendly);
}
