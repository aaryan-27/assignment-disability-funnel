import type {
  Attribution,
  AutomationStatus,
  LeadStatus,
  QualificationOutcome,
} from '@funnel/shared';

export interface LeadRecord {
  lead_id: string;
  created_at: string;
  updated_at: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  funnel_version: string;
  lead_status: LeadStatus;
  qualification_outcome: QualificationOutcome;
  qualification_score: number;
  /** Reason codes. Internal only - never leaves for an ad platform. */
  qualification_reasons: string[];
  session_id: string;
  /** The shared Pixel/CAPI dedup key for this lead's `Lead` conversion. */
  conversion_event_id: string;
  attribution: Attribution;
  /** Hashed IP + UA are stored for CAPI; the raw IP is not retained. */
  client_ip_hash?: string;
  client_user_agent?: string;
  /** True once at least one automation run has written it to the CRM. */
  synced_to_crm: boolean;
}

export interface QualificationRecord {
  qualification_id: string;
  lead_id: string;
  question_id: string;
  answer: string;
  timestamp: string;
}

export interface EventRecord {
  event_id: string;
  lead_id?: string;
  session_id: string;
  event_name: string;
  timestamp: string;
  source: 'browser' | 'server';
  status: 'received' | 'sent' | 'failed' | 'skipped' | 'duplicate';
  /** Set when the browser pixel also fired this event_id (dedup expected). */
  pixel_fired: boolean;
  /** Set when Meta accepted the server copy. */
  meta_delivered?: boolean;
  error?: string;
  step_number?: number;
  question_id?: string;
}

export interface AutomationRun {
  run_id: string;
  lead_id?: string;
  event_id?: string;
  workflow: string;
  status: AutomationStatus;
  retry_count: number;
  error?: string;
  last_attempt?: string;
  created_at: string;
  updated_at: string;
  /** Latency of the most recent attempt, in milliseconds. */
  duration_ms?: number;
  /** Free-form integration response summary (ids, not payloads). */
  result?: Record<string, unknown>;
}

export type OutboxJobType = 'meta_capi' | 'lead_to_airtable';

export interface OutboxJob {
  job_id: string;
  type: OutboxJobType;
  /** Human-readable workflow name, e.g. `meta_capi_Lead`. Surfaced in the
   *  admin view so an operator can tell two jobs of the same type apart. */
  workflow: string;
  /** Idempotency key carried end-to-end. */
  dedupe_key: string;
  lead_id?: string;
  event_id?: string;
  payload: Record<string, unknown>;
  status: AutomationStatus;
  attempts: number;
  max_attempts: number;
  /** ISO timestamp; the worker ignores jobs scheduled in the future. */
  next_attempt_at: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
  run_id: string;
}

export interface IdempotencyRecord {
  key: string;
  lead_id: string;
  created_at: string;
  /** The exact response we returned first time, replayed on a repeat call. */
  response: Record<string, unknown>;
}

export interface DatabaseShape {
  leads: LeadRecord[];
  qualification: QualificationRecord[];
  events: EventRecord[];
  automation_runs: AutomationRun[];
  outbox: OutboxJob[];
  idempotency: IdempotencyRecord[];
  /** Counters that are cheaper to increment than to recompute. */
  counters: Record<string, number>;
}

export const emptyDatabase = (): DatabaseShape => ({
  leads: [],
  qualification: [],
  events: [],
  automation_runs: [],
  outbox: [],
  idempotency: [],
  counters: {},
});
