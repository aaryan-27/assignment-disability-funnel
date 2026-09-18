import { IntegrationError, isRetryableStatus } from './errors.js';

/**
 * fetch with a hard timeout.
 *
 * Node's fetch has no default timeout, so a hung downstream would pin an outbox
 * worker slot forever. A timeout is classified as retryable: the request may
 * well have succeeded, which is exactly why every downstream call in this
 * system is idempotent.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  integration: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new IntegrationError(
      integration,
      aborted ? `Request timed out after ${timeoutMs}ms` : `Network error: ${String(error)}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a response, converting non-2xx into a correctly classified error. */
export async function readJsonResponse<T>(
  response: Response,
  integration: string,
): Promise<T> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    throw new IntegrationError(
      integration,
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      { retryable: isRetryableStatus(response.status), statusCode: response.status },
    );
  }

  return parsed as T;
}
