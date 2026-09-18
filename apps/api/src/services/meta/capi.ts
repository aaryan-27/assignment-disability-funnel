import { env, integrations } from '../../config/env.js';
import { IntegrationError } from '../../lib/errors.js';
import { fetchWithTimeout, readJsonResponse } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { maybeInjectFailure, mockLatency } from '../mockControl.js';
import type { MetaServerEvent } from './payload.js';

export interface CapiResult {
  delivered: boolean;
  mocked: boolean;
  events_received?: number;
  fbtrace_id?: string;
  /** Echoed so the caller can prove which dedup key was used. */
  event_id: string;
}

/**
 * Send one event to the Conversions API.
 *
 * Called exclusively from the outbox worker, never inline on the request path -
 * a slow Meta response must not delay the user's success screen, and a failed
 * Meta call must not fail the lead.
 */
export async function sendServerEvent(event: MetaServerEvent): Promise<CapiResult> {
  if (!integrations.meta.enabled) {
    logger.info('meta.capi_disabled', { event_name: event.event_name, event_id: event.event_id });
    return { delivered: false, mocked: true, event_id: event.event_id };
  }

  if (integrations.meta.mock) {
    maybeInjectFailure('meta');
    await mockLatency();
    // The log line is the deliverable in mock mode: it shows the exact shape
    // that would go to Meta, including the hashed match keys.
    logger.info('meta.capi_mock_send', {
      event_name: event.event_name,
      event_id: event.event_id,
      action_source: event.action_source,
      /** Which match keys were present - the values stay redacted. */
      match_keys: Object.keys(event.user_data),
      custom_data: event.custom_data,
      test_event_code: env.META_TEST_EVENT_CODE || undefined,
    });
    return { delivered: true, mocked: true, events_received: 1, event_id: event.event_id };
  }

  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_PIXEL_ID}/events`;

  const body: Record<string, unknown> = {
    data: [event],
    access_token: env.META_ACCESS_TOKEN,
  };
  // Only present while validating in Events Manager. Leaving this set in
  // production silently diverts every conversion into the test stream.
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    8000,
    'meta',
  );

  const parsed = await readJsonResponse<{
    events_received?: number;
    fbtrace_id?: string;
    error?: { message?: string; code?: number; is_transient?: boolean };
  }>(response, 'meta');

  if (parsed.error) {
    throw new IntegrationError('meta', parsed.error.message ?? 'Meta CAPI error', {
      // Meta tells us whether a retry could help; trust it when present.
      retryable: parsed.error.is_transient ?? false,
    });
  }

  logger.info('meta.capi_sent', {
    event_name: event.event_name,
    event_id: event.event_id,
    events_received: parsed.events_received,
    fbtrace_id: parsed.fbtrace_id,
  });

  return {
    delivered: true,
    mocked: false,
    events_received: parsed.events_received,
    fbtrace_id: parsed.fbtrace_id,
    event_id: event.event_id,
  };
}
