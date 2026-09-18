import { newSessionId, type Attribution } from '@funnel/shared';
import { webEnv } from './env.js';
import { readStored, STORAGE_KEYS, writeStored } from './storage.js';

/**
 * Attribution capture.
 *
 * The rule that matters: capture on the FIRST page view and never overwrite it.
 * A user who lands from a Facebook ad, opens a new tab, comes back via Google
 * and then converts must still be credited to the Facebook ad. Re-reading the
 * query string on every render would silently rewrite history - a classic and
 * expensive attribution bug.
 */

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

/** Reads a first-party cookie. Meta's Pixel writes `_fbp` and `_fbc`. */
export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function captureFromUrl(): Attribution {
  const params = new URLSearchParams(window.location.search);
  const attribution: Attribution = {
    funnel_version: webEnv.funnelVersion,
    landing_page: `${window.location.origin}${window.location.pathname}`,
    referrer: document.referrer || undefined,
    client_timestamp: new Date().toISOString(),
  };

  for (const utmKey of UTM_KEYS) {
    const value = params.get(utmKey);
    if (value) attribution[utmKey] = value.slice(0, 200);
  }

  const fbclid = params.get('fbclid');
  if (fbclid) attribution.fbclid = fbclid.slice(0, 500);

  const gclid = params.get('gclid');
  if (gclid) attribution.gclid = gclid.slice(0, 500);

  return attribution;
}

/**
 * Get the attribution for this visitor, capturing it once and reusing it for
 * the rest of the session (and across an accidental refresh).
 */
export function getAttribution(): Attribution {
  const stored = readStored<Attribution>(STORAGE_KEYS.attribution);

  const base = stored ?? captureFromUrl();
  if (!stored) writeStored(STORAGE_KEYS.attribution, base);

  // The Meta cookies are re-read every time: the Pixel writes `_fbp` slightly
  // after page load, so the value at first capture is often missing. Reading
  // late is what turns a mediocre match rate into a good one.
  return {
    ...base,
    funnel_version: webEnv.funnelVersion,
    fbp: readCookie('_fbp') ?? base.fbp,
    fbc: readCookie('_fbc') ?? base.fbc,
  };
}

/** Stable id for this visitor's funnel attempt. Survives a refresh. */
export function getSessionId(): string {
  const stored = readStored<string>(STORAGE_KEYS.session);
  if (stored) return stored;

  const sessionId = newSessionId();
  writeStored(STORAGE_KEYS.session, sessionId);
  return sessionId;
}
