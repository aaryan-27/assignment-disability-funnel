/**
 * Event taxonomy and the privacy boundary.
 *
 * There are two audiences for events:
 *   1. Our own analytics / operational store  - gets the full picture.
 *   2. Meta (Pixel + Conversions API)         - gets a deliberately thin slice.
 *
 * The funnel collects disability, medical and financial information. Sending
 * that to an advertising platform as custom event parameters would be a serious
 * privacy failure (and in the US likely an unlawful one under HIPAA-adjacent
 * and state health-privacy rules, plus a direct violation of Meta's own
 * prohibition on sending health data). The allowlist below is the single
 * enforcement point: anything not explicitly listed never leaves for Meta.
 */

export const FUNNEL_EVENTS = {
  PageView: 'PageView',
  ViewContent: 'ViewContent',
  FunnelStarted: 'FunnelStarted',
  QuestionCompleted: 'QuestionCompleted',
  QualificationStarted: 'QualificationStarted',
  QualificationCompleted: 'QualificationCompleted',
  EmailCaptured: 'EmailCaptured',
  Lead: 'Lead',
} as const;

export type FunnelEventName = (typeof FUNNEL_EVENTS)[keyof typeof FUNNEL_EVENTS];

/** Where an event was observed. Used for dedup diagnostics. */
export type EventSource = 'browser' | 'server';

/** How an event is delivered to Meta, if at all. */
export type MetaDelivery = 'none' | 'browser' | 'server' | 'both';

export interface EventDefinition {
  name: FunnelEventName;
  /**
   * Meta's standard event name, when it maps to one. Custom funnel milestones
   * are sent as custom events or not at all.
   */
  metaEventName?: string;
  delivery: MetaDelivery;
  /**
   * `both` events are the ones that need a shared event_id so Meta can
   * deduplicate the browser and the server copy of the same conversion.
   */
  requiresSharedEventId: boolean;
  description: string;
}

export const EVENT_DEFINITIONS: Record<FunnelEventName, EventDefinition> = {
  PageView: {
    name: 'PageView',
    metaEventName: 'PageView',
    delivery: 'browser',
    requiresSharedEventId: false,
    description: 'Standard pixel page view. Browser only - no server value.',
  },
  ViewContent: {
    name: 'ViewContent',
    metaEventName: 'ViewContent',
    delivery: 'browser',
    requiresSharedEventId: false,
    description: 'Funnel landing screen rendered.',
  },
  FunnelStarted: {
    name: 'FunnelStarted',
    metaEventName: 'FunnelStarted',
    delivery: 'browser',
    requiresSharedEventId: false,
    description: 'User answered the first question. Top-of-funnel custom event.',
  },
  QuestionCompleted: {
    name: 'QuestionCompleted',
    // Intentionally NOT sent to Meta: high volume, low signal, and the payload
    // would necessarily describe which health question was answered.
    delivery: 'none',
    requiresSharedEventId: false,
    description: 'Internal step telemetry powering funnel drop-off analysis.',
  },
  QualificationStarted: {
    name: 'QualificationStarted',
    delivery: 'none',
    requiresSharedEventId: false,
    description:
      'First question rendered. Paired with FunnelStarted (first question ANSWERED) this measures the largest single drop in any quiz funnel: people who see question one and never engage.',
  },
  QualificationCompleted: {
    name: 'QualificationCompleted',
    metaEventName: 'QualificationCompleted',
    delivery: 'server',
    requiresSharedEventId: false,
    description:
      'All qualification questions answered. Server-side only so it cannot be blocked by an ad blocker; carries no answer detail.',
  },
  EmailCaptured: {
    name: 'EmailCaptured',
    // Meta's standard mid-funnel event for a partial lead.
    metaEventName: 'CompleteRegistration',
    delivery: 'both',
    requiresSharedEventId: true,
    description: 'Email captured. Dual-sent with a shared event_id for dedup.',
  },
  Lead: {
    name: 'Lead',
    metaEventName: 'Lead',
    delivery: 'both',
    requiresSharedEventId: true,
    description:
      'Primary conversion. Dual-sent with a shared event_id. Only fired for qualified / review outcomes.',
  },
};

/**
 * THE PRIVACY ALLOWLIST.
 *
 * Custom parameter keys that are permitted to reach Meta. Everything else is
 * stripped by `sanitiseMetaCustomData`. Note what is absent: every question id,
 * every answer value, the qualification reason codes and the raw score.
 */
export const META_ALLOWED_CUSTOM_PARAMS = new Set([
  'content_name', // static funnel name, e.g. "disability-qualification"
  'content_category', // static, e.g. "benefits"
  'currency',
  'value', // modelled lead value, never a financial answer
  'funnel_version',
  'lead_quality', // coarse bucket only: 'standard' | 'priority'
  'step_number', // integer position, never the question text
]);

/**
 * Question ids whose answers may be used for Meta Advanced Matching.
 * These are identity fields, hashed with SHA-256 before transmission.
 * `gender` is included because Meta supports it as a matching parameter and it
 * is not health information; every other answer is excluded.
 */
export const META_ALLOWED_MATCHING_QUESTION_IDS = new Set(['gender']);

export interface MetaCustomData {
  [key: string]: string | number | undefined;
}

/**
 * Strip everything that is not explicitly allowed.
 *
 * Deny-by-default: adding a new question can never accidentally leak, because a
 * new key is simply not in the allowlist. Returns the surviving keys plus the
 * names of what was dropped, so the caller can log a privacy-guard warning
 * without logging the values themselves.
 */
export function sanitiseMetaCustomData(input: MetaCustomData): {
  data: MetaCustomData;
  dropped: string[];
} {
  const data: MetaCustomData = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (META_ALLOWED_CUSTOM_PARAMS.has(key)) {
      data[key] = value;
    } else {
      dropped.push(key);
    }
  }

  return { data, dropped };
}

/** Coarse bucket sent to Meta in place of the numeric qualification score. */
export function toLeadQualityBucket(outcome: string): 'priority' | 'standard' {
  return outcome === 'qualified' ? 'priority' : 'standard';
}

export function shouldSendToMeta(eventName: FunnelEventName, source: EventSource): boolean {
  const definition = EVENT_DEFINITIONS[eventName];
  if (!definition) return false;
  if (definition.delivery === 'none') return false;
  if (definition.delivery === 'both') return true;
  return definition.delivery === source;
}

export function getMetaEventName(eventName: FunnelEventName): string | undefined {
  return EVENT_DEFINITIONS[eventName]?.metaEventName;
}
