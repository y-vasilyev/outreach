export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export const Errors = {
  notFound: (target: string, id?: string) =>
    new AppError('NOT_FOUND', `${target}${id ? ` ${id}` : ''} not found`, 404),
  badRequest: (msg: string, details?: unknown) =>
    new AppError('BAD_REQUEST', msg, 400, details),
  unauthorized: (msg = 'Unauthorized') => new AppError('UNAUTHORIZED', msg, 401),
  forbidden: (msg = 'Forbidden') => new AppError('FORBIDDEN', msg, 403),
  conflict: (msg: string) => new AppError('CONFLICT', msg, 409),
  rateLimited: (msg = 'Rate limited') => new AppError('RATE_LIMITED', msg, 429),
  upstream: (msg: string, details?: unknown) =>
    new AppError('UPSTREAM_ERROR', msg, 502, details),
  /**
   * LLM returned text that wasn't valid JSON (or extractor couldn't find one).
   * Distinct from a transient upstream — this means the *model* misbehaved,
   * not the network. Worth retrying once with a "JSON only" reminder.
   */
  llmInvalidJson: (msg: string, details?: unknown) =>
    new AppError('LLM_INVALID_JSON', msg, 502, details),
  /**
   * LLM returned valid JSON but it failed the agent's outputSchema. Caller
   * should attempt a repair-loop: re-prompt with the validation error and
   * the previous response so the model can fix only the broken fields.
   */
  llmSchemaFailed: (msg: string, details?: unknown) =>
    new AppError('LLM_SCHEMA_FAILED', msg, 502, details),
  /**
   * Network/HTTP-level failure talking to the LLM provider (5xx, timeout,
   * 429). Should retry with backoff before falling over to a different
   * endpoint. Carries `{ status }` in details when known.
   */
  llmTransient: (msg: string, details?: unknown) =>
    new AppError('LLM_TRANSIENT', msg, 502, details),
  internal: (msg = 'Internal error', details?: unknown) =>
    new AppError('INTERNAL', msg, 500, details),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
