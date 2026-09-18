import { getSessionId } from '../lib/attribution.js';
import { webEnv } from '../lib/env.js';

/**
 * Meta Pixel bootstrap.
 *
 * Loaded from code rather than pasted into index.html so that:
 *   - it is a no-op when no pixel id is configured (local dev, CI, previews);
 *   - `fbq` is typed instead of being an untyped global sprinkled everywhere;
 *   - the queue exists before the script finishes loading, so no early event
 *     is dropped.
 */

type FbqFn = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  push?: unknown;
  loaded?: boolean;
  version?: string;
};

declare global {
  interface Window {
    fbq?: FbqFn;
    _fbq?: FbqFn;
  }
}

let initialised = false;

export function isPixelAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.fbq === 'function';
}

export function initPixel(): void {
  if (initialised) return;
  if (typeof window === 'undefined') return;

  if (!webEnv.metaPixelId) {
    // No pixel configured. The tracking layer still records every event to our
    // own API, so the funnel analytics are complete even with no Meta account.
    initialised = true;
    return;
  }

  // Standard Meta bootstrap: build the queue first so calls made before the
  // remote script lands are replayed rather than lost.
  if (!window.fbq) {
    const fbq: FbqFn = function fbqShim(...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue?.push(args);
    } as FbqFn;

    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = '2.0';
    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }

  // external_id: the same persisted visitor id the server sends with CAPI
  // events, so both copies of a conversion match to the same person. The Pixel
  // normalises and hashes it before it leaves the browser.
  window.fbq?.('init', webEnv.metaPixelId, { external_id: getSessionId() });
  initialised = true;
}

export interface PixelSendOptions {
  /** Shared dedup key. Meta drops the duplicate when CAPI sends the same id. */
  eventId: string;
  /** Standard events go through `track`; ours go through `trackCustom`. */
  isStandard: boolean;
  parameters?: Record<string, string | number | undefined>;
}

/**
 * Fire a browser-side event.
 *
 * Returns whether the Pixel actually fired. The caller forwards that flag to
 * the server so the backend knows whether a deduplicating server copy is
 * needed - if an ad blocker stopped the Pixel, the server copy is the only
 * copy, and Meta still gets exactly one event.
 */
export function sendPixelEvent(eventName: string, options: PixelSendOptions): boolean {
  if (!isPixelAvailable()) return false;

  try {
    const method = options.isStandard ? 'track' : 'trackCustom';
    window.fbq?.(method, eventName, options.parameters ?? {}, { eventID: options.eventId });
    return true;
  } catch {
    // A Pixel failure must never break the funnel.
    return false;
  }
}

/** Meta standard events. Anything else must be sent via trackCustom. */
const STANDARD_EVENTS = new Set([
  'PageView',
  'ViewContent',
  'Lead',
  'CompleteRegistration',
  'Contact',
  'Purchase',
  'InitiateCheckout',
  'Search',
  'AddToCart',
  'SubmitApplication',
  'Schedule',
  'StartTrial',
  'Subscribe',
  'AddPaymentInfo',
  'AddToWishlist',
  'CustomizeProduct',
  'Donate',
  'FindLocation',
]);

export function isStandardEvent(metaEventName: string): boolean {
  return STANDARD_EVENTS.has(metaEventName);
}
