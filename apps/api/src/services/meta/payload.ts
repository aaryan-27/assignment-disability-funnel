import {
  getMetaEventName,
  sanitiseMetaCustomData,
  toLeadQualityBucket,
  type FunnelEventName,
  type MetaCustomData,
} from '@funnel/shared';
import { env } from '../../config/env.js';
import { hashEmail, hashGender, hashName, hashPhone } from '../../lib/hash.js';
import { logger } from '../../lib/logger.js';

/**
 * Conversions API payload construction.
 *
 * Two things matter here and nothing else does:
 *   1. Match quality  - send every identifier we legitimately have, correctly
 *                       normalised and hashed, so Meta can attribute the
 *                       conversion to the click that produced it.
 *   2. Privacy        - send nothing about the user's health, finances or
 *                       answers. The allowlist in @funnel/shared is the single
 *                       enforcement point and it denies by default.
 */

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ge?: string[];
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface MetaServerEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url?: string;
  action_source: 'website';
  user_data: MetaUserData;
  custom_data?: MetaCustomData;
  opt_out?: boolean;
}

export interface BuildEventInput {
  eventName: FunnelEventName;
  eventId: string;
  eventTime?: Date;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  clientIp?: string;
  userAgent?: string;
  sourceUrl?: string;
  /** Coarse quality bucket, derived from the qualification outcome. */
  qualificationOutcome?: string;
  /** Modelled lead value in USD. Not a user-supplied financial figure. */
  value?: number;
  stepNumber?: number;
}

/**
 * Reconstruct the `fbc` click id cookie from a raw `fbclid`.
 *
 * Meta's format is `fb.{subdomainIndex}.{timestamp}.{fbclid}`. When a user
 * lands with ?fbclid= but the Pixel has not yet written the cookie (ad blocker,
 * slow script, JS disabled), synthesising it server-side recovers attribution
 * that would otherwise be lost outright. This is one of the highest-leverage
 * few lines in the whole tracking stack.
 */
export function buildFbc(fbclid: string | undefined, timestamp = Date.now()): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${timestamp}.${fbclid}`;
}

function wrap(value: string | undefined): string[] | undefined {
  return value ? [value] : undefined;
}

export function buildUserData(input: BuildEventInput): MetaUserData {
  const userData: MetaUserData = {
    em: wrap(hashEmail(input.email)),
    ph: wrap(hashPhone(input.phone)),
    fn: wrap(hashName(input.firstName)),
    ln: wrap(hashName(input.lastName)),
    ge: wrap(hashGender(input.gender)),
    fbp: input.fbp,
    fbc: input.fbc ?? buildFbc(input.fbclid),
    client_ip_address: input.clientIp,
    client_user_agent: input.userAgent,
  };

  // Drop empty keys: Meta counts a present-but-empty field against match quality.
  for (const key of Object.keys(userData) as (keyof MetaUserData)[]) {
    if (userData[key] === undefined) delete userData[key];
  }

  return userData;
}

export function buildServerEvent(input: BuildEventInput): MetaServerEvent | null {
  const metaEventName = getMetaEventName(input.eventName);
  if (!metaEventName) {
    // Event is internal-only by design (e.g. QuestionCompleted).
    return null;
  }

  const rawCustomData: MetaCustomData = {
    content_name: 'disability-qualification',
    content_category: 'benefits',
    funnel_version: env.FUNNEL_VERSION,
    lead_quality: input.qualificationOutcome
      ? toLeadQualityBucket(input.qualificationOutcome)
      : undefined,
    value: input.value,
    currency: input.value !== undefined ? 'USD' : undefined,
    step_number: input.stepNumber,
  };

  const { data: customData, dropped } = sanitiseMetaCustomData(rawCustomData);

  if (dropped.length > 0) {
    // Fires only if someone adds a parameter without adding it to the allowlist.
    // Loud on purpose: this is the guardrail doing its job.
    logger.warn('meta.custom_data_dropped_by_privacy_guard', {
      event_name: input.eventName,
      dropped_keys: dropped,
    });
  }

  return {
    event_name: metaEventName,
    event_time: Math.floor((input.eventTime ?? new Date()).getTime() / 1000),
    event_id: input.eventId,
    event_source_url: input.sourceUrl,
    action_source: 'website',
    user_data: buildUserData(input),
    custom_data: customData,
  };
}

/**
 * Meta rejects events older than 7 days. A job sitting in the dead-letter queue
 * over a long weekend must not be resubmitted into a rejection.
 */
export function isEventTooOld(eventTime: Date, now = new Date()): boolean {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return now.getTime() - eventTime.getTime() > sevenDaysMs;
}
