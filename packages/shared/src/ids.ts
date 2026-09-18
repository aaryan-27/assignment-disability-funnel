/**
 * Prefixed, collision-resistant, URL-safe identifiers.
 *
 * Prefixes make ids self-describing in logs, in Airtable and in Meta's Events
 * Manager, which matters a lot when you are debugging a deduplication problem
 * at 2am. Uses the Web Crypto API, which is available in modern browsers and in
 * Node 20+, so the same generator runs on both tiers.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // globalThis.crypto is standard in browsers and Node >= 19.
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  // Defensive fallback; never hit on a supported runtime.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // `!` is safe: i < length and bytes has exactly `length` entries.
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export const ID_PREFIXES = {
  lead: 'ld',
  event: 'evt',
  session: 'ses',
  run: 'run',
  qualification: 'qal',
  job: 'job',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function prefixed(prefix: IdPrefix, length: number): string {
  return `${prefix}_${randomId(length)}`;
}

export const newLeadId = (): string => prefixed(ID_PREFIXES.lead, 16);
export const newEventId = (): string => prefixed(ID_PREFIXES.event, 18);
export const newSessionId = (): string => prefixed(ID_PREFIXES.session, 16);
export const newRunId = (): string => prefixed(ID_PREFIXES.run, 16);
export const newQualificationId = (): string => prefixed(ID_PREFIXES.qualification, 16);
export const newJobId = (): string => prefixed(ID_PREFIXES.job, 16);

const ID_PATTERN = /^(ld|evt|ses|run|qal|job)_[a-z0-9]{8,32}$/;

export function isValidId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_PATTERN.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}
