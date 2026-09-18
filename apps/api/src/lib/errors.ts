/** Errors that are safe to surface to a client, with a stable machine code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Unauthorized'): AppError =>
  new AppError(401, 'unauthorized', message);

export const notFound = (message = 'Not found'): AppError =>
  new AppError(404, 'not_found', message);

export const tooManyRequests = (message = 'Too many requests'): AppError =>
  new AppError(429, 'rate_limited', message);

/**
 * A failure from a downstream integration. `retryable` drives the outbox: a
 * 4xx from Airtable means our payload is wrong and retrying will never help,
 * whereas a 5xx or a timeout should be retried with backoff.
 */
export class IntegrationError extends Error {
  readonly integration: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    integration: string,
    message: string,
    options: { retryable?: boolean; statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'IntegrationError';
    this.integration = integration;
    this.retryable = options.retryable ?? true;
    this.statusCode = options.statusCode;
    if (options.cause) this.cause = options.cause;
  }
}

/** HTTP status codes worth retrying. 429 included: it is explicitly temporary. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
