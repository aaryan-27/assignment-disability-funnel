import {
  EVENT_DEFINITIONS,
  getMetaEventName,
  newEventId,
  sanitiseMetaCustomData,
  shouldSendToMeta,
  type FunnelEventName,
} from '@funnel/shared';
import { getAttribution, getSessionId } from '../lib/attribution.js';
import { webEnv } from '../lib/env.js';
import { postEvent } from '../lib/api.js';
import { initPixel, isStandardEvent, sendPixelEvent } from './pixel.js';

/**
 * The tracking layer.
 *
 * Components never call `fbq` and never call the events API directly. They call
 * `trackEvent(...)` and this module decides, from the event taxonomy, whether
 * the event goes to the Pixel, to our server, to both, or nowhere.
 *
 * Centralising it buys three things that scattered tracking calls never give
 * you: one place where the dedup event_id is minted, one place where the
 * privacy allowlist is applied, and one place to look when an event is missing.
 */

export interface TrackEventInput {
  eventName: FunnelEventName;
  /** Supply to reuse a dedup key across the browser and server copies. */
  eventId?: string;
  leadId?: string;
  questionId?: string;
  stepNumber?: number;
  /** Extra Meta parameters. Filtered through the shared allowlist. */
  parameters?: Record<string, string | number | undefined>;
}

export interface TrackEventResult {
  eventId: string;
  pixelFired: boolean;
  /** Whether the server beacon was accepted. */
  serverAccepted: boolean;
}

function debugLog(message: string, payload: Record<string, unknown>): void {
  if (!webEnv.trackingDebug) return;
  // Grouped, prefixed and greppable. In mock mode this console output *is* the
  // observability surface for the browser half of the stack.
  // eslint-disable-next-line no-console
  console.info(`%c[track] ${message}`, 'color:#7c43ff;font-weight:600', payload);
}

export function initTracking(): void {
  initPixel();
}

/**
 * Track one funnel event.
 *
 * Never throws and never rejects in a way that can break a click handler: a
 * tracking outage must not stop a user from converting.
 */
export async function trackEvent(input: TrackEventInput): Promise<TrackEventResult> {
  const eventId = input.eventId ?? newEventId();
  const definition = EVENT_DEFINITIONS[input.eventName];
  const sessionId = getSessionId();

  let pixelFired = false;

  // --- Browser copy ---------------------------------------------------------
  if (definition && shouldSendToMeta(input.eventName, 'browser')) {
    const metaEventName = getMetaEventName(input.eventName);
    if (metaEventName) {
      // Deny-by-default: the same allowlist the server uses. A sensitive answer
      // cannot reach Meta even if a component passes it in by mistake.
      const { data, dropped } = sanitiseMetaCustomData({
        content_name: 'disability-qualification',
        content_category: 'benefits',
        funnel_version: webEnv.funnelVersion,
        ...input.parameters,
      });

      if (dropped.length > 0) {
        debugLog('privacy guard dropped parameters', { dropped, event: input.eventName });
      }

      pixelFired = sendPixelEvent(metaEventName, {
        eventId,
        isStandard: isStandardEvent(metaEventName),
        parameters: data,
      });
    }
  }

  // --- Server copy ----------------------------------------------------------
  // Every event is beaconed, including internal-only ones: our own funnel
  // analytics need the complete picture even when Meta gets nothing.
  let serverAccepted = false;
  try {
    const attribution = getAttribution();
    serverAccepted = await postEvent({
      event_name: input.eventName,
      event_id: eventId,
      session_id: sessionId,
      lead_id: input.leadId,
      question_id: input.questionId,
      step_number: input.stepNumber,
      pixel_fired: pixelFired,
      attribution: {
        fbp: attribution.fbp,
        fbc: attribution.fbc,
        fbclid: attribution.fbclid,
        utm_source: attribution.utm_source,
        utm_campaign: attribution.utm_campaign,
        landing_page: attribution.landing_page,
      },
    });
  } catch {
    // Beacons are best effort by definition.
    serverAccepted = false;
  }

  debugLog(input.eventName, {
    event_id: eventId,
    delivery: definition?.delivery ?? 'none',
    pixel_fired: pixelFired,
    server_accepted: serverAccepted,
    step: input.stepNumber,
    question_id: input.questionId,
  });

  return { eventId, pixelFired, serverAccepted };
}

/**
 * Mint the shared dedup id for a conversion.
 *
 * Called once, before submitting, so the Pixel copy and the CAPI copy carry the
 * same `event_id`. Meta then counts one conversion instead of two - which is
 * the entire point of running both.
 */
export function createConversionEventId(): string {
  return newEventId();
}
