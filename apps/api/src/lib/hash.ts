import { createHash, timingSafeEqual } from 'node:crypto';
import { normalisePhone } from '@funnel/shared';

/**
 * Meta Advanced Matching requires user data to be normalised *then* hashed with
 * SHA-256. Getting normalisation wrong silently destroys match quality - the
 * request still returns 200, you just quietly lose attribution. These helpers
 * implement Meta's documented rules so the normalisation lives in one place.
 */

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashNormalised(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalised = value.trim().toLowerCase();
  if (!normalised) return undefined;
  return sha256(normalised);
}

export const hashEmail = (email: string | undefined): string | undefined =>
  hashNormalised(email);

/**
 * Phones must be digits only, including country code, with no leading zeros or
 * punctuation. We assume US numbers (this funnel is US-only) and prepend `1`
 * for bare 10-digit numbers.
 */
export function hashPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  let digits = normalisePhone(phone);
  if (!digits) return undefined;
  if (digits.length === 10) digits = `1${digits}`;
  return sha256(digits);
}

export const hashName = (name: string | undefined): string | undefined => hashNormalised(name);

/** Same trim + lowercase + SHA-256 the Pixel applies to its external_id. */
export const hashExternalId = (id: string | undefined): string | undefined => hashNormalised(id);

/** Meta expects a single character: `m`, `f`. Anything else is omitted. */
export function hashGender(gender: string | undefined): string | undefined {
  if (gender === 'male') return sha256('m');
  if (gender === 'female') return sha256('f');
  return undefined;
}

/** Constant-time comparison for shared secrets and admin tokens. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** HMAC-style signature for the n8n webhook, using SHA-256 over body+secret. */
export function signPayload(body: string, secret: string): string {
  return createHash('sha256').update(`${body}.${secret}`, 'utf8').digest('hex');
}
