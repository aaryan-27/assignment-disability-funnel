import { env, isTest } from '../config/env.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Deliberate failure injection.
 *
 * The reliability architecture is only credible if you can watch it work. These
 * switches let an interviewer break Airtable mid-demo and see the lead survive,
 * the run go to `failed`, the backoff schedule kick in and the retry succeed
 * without producing a duplicate.
 *
 * Runtime overrides (set from the admin API) layer on top of the env defaults
 * so failures can be toggled without restarting the server.
 */

type Integration = 'airtable' | 'n8n' | 'meta';

const runtimeOverrides: Partial<Record<Integration, boolean>> = {};
let runtimeFailureRate: number | null = null;

export function setFailureInjection(integration: Integration, enabled: boolean): void {
  runtimeOverrides[integration] = enabled;
  logger.warn('mock.failure_injection_changed', { integration, enabled });
}

export function setFailureRate(rate: number): void {
  runtimeFailureRate = Math.max(0, Math.min(1, rate));
  logger.warn('mock.failure_rate_changed', { rate: runtimeFailureRate });
}

export function getFailureInjectionState(): Record<string, unknown> {
  return {
    airtable: runtimeOverrides.airtable ?? env.MOCK_AIRTABLE_FAILURE,
    n8n: runtimeOverrides.n8n ?? env.MOCK_N8N_FAILURE,
    meta: runtimeOverrides.meta ?? env.MOCK_META_FAILURE,
    failure_rate: runtimeFailureRate ?? env.MOCK_FAILURE_RATE,
  };
}

function isForced(integration: Integration): boolean {
  const override = runtimeOverrides[integration];
  if (override !== undefined) return override;
  if (integration === 'airtable') return env.MOCK_AIRTABLE_FAILURE;
  if (integration === 'n8n') return env.MOCK_N8N_FAILURE;
  return env.MOCK_META_FAILURE;
}

/**
 * Throw if this call is supposed to fail.
 *
 * Injected failures are marked retryable so they exercise the backoff path
 * rather than short-circuiting to the dead-letter queue.
 */
export function maybeInjectFailure(integration: Integration): void {
  if (isForced(integration)) {
    throw new IntegrationError(integration, `Injected ${integration} failure (mock mode)`, {
      retryable: true,
      statusCode: 503,
    });
  }

  const rate = runtimeFailureRate ?? env.MOCK_FAILURE_RATE;
  if (rate > 0 && Math.random() < rate) {
    throw new IntegrationError(
      integration,
      `Injected probabilistic ${integration} failure (rate=${rate})`,
      { retryable: true, statusCode: 503 },
    );
  }
}

/**
 * Simulates realistic network latency so a mock demo does not look
 * suspiciously instant. Skipped in tests, where it would only add wall-clock
 * time to an otherwise deterministic suite.
 */
export function mockLatency(minMs = 40, maxMs = 160): Promise<void> {
  if (isTest) return Promise.resolve();
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
