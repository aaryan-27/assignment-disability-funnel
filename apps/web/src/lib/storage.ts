/**
 * Namespaced, quota-safe, schema-versioned local storage.
 *
 * Every accessor is wrapped: Safari private mode throws on setItem, and some
 * corporate browser policies disable storage entirely. A funnel that crashes
 * because it could not autosave is strictly worse than one that silently
 * forgets - so every failure degrades to "no persistence" rather than an error.
 */

const NAMESPACE = 'dp_funnel';
/** Bump to invalidate every saved session after a breaking config change. */
const SCHEMA_VERSION = 1;

interface Envelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

/** Saved progress older than this is discarded as stale. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 3;

function key(name: string): string {
  return `${NAMESPACE}:${name}`;
}

export function readStored<T>(name: string): T | null {
  try {
    const raw = window.localStorage.getItem(key(name));
    if (!raw) return null;

    const envelope = JSON.parse(raw) as Envelope<T>;
    if (envelope.v !== SCHEMA_VERSION) return null;
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) {
      clearStored(name);
      return null;
    }
    return envelope.data;
  } catch {
    return null;
  }
}

export function writeStored<T>(name: string, data: T): void {
  try {
    const envelope: Envelope<T> = { v: SCHEMA_VERSION, savedAt: Date.now(), data };
    window.localStorage.setItem(key(name), JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled. Autosave is a convenience, not a
    // requirement - the funnel keeps working from in-memory state.
  }
}

export function clearStored(name: string): void {
  try {
    window.localStorage.removeItem(key(name));
  } catch {
    // ignore
  }
}

export const STORAGE_KEYS = {
  progress: 'progress',
  session: 'session',
  attribution: 'attribution',
} as const;
