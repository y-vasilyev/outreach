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
  internal: (msg = 'Internal error', details?: unknown) =>
    new AppError('INTERNAL', msg, 500, details),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
