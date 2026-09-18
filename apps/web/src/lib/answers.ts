import type { FunnelAnswers } from '@funnel/shared';

/**
 * Drop unanswered keys.
 *
 * `FunnelAnswers` allows `undefined` values so the state machine can represent
 * "asked but not yet answered". The wire contract does not - an explicit
 * `undefined` in JSON is either dropped or becomes null, and neither is
 * meaningful to the server. Compacting here keeps the boundary honest.
 */
export function compactAnswers(answers: FunnelAnswers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
