import type { Attribution, LeadSubmission } from '@funnel/shared';
import { webEnv } from './env.js';
import { getAdminToken } from './adminAuth.js';

/**
 * API client.
 *
 * Two behaviours matter more than anything else here:
 *   1. The lead submission retries, and carries a stable idempotency key so a
 *      retry cannot create a second lead or a second Meta conversion.
 *   2. Errors are typed, so the UI can distinguish "your phone number is wrong"
 *      (fix it inline) from "our server is down" (offer to retry).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field-level messages from server-side validation. */
  readonly fields?: Record<string, string>;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    // 4xx means the request itself is wrong; retrying it unchanged is pointless.
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);

  // Honour an externally supplied signal as well as our own timeout.
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${webEnv.apiBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const error = (payload.error ?? {}) as {
        code?: string;
        message?: string;
        fields?: Record<string, string>;
      };
      throw new ApiError(
        response.status,
        error.code ?? 'request_failed',
        error.message ?? `Request failed with status ${response.status}`,
        error.fields,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Network failure or abort. Status 0 marks it retryable.
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      0,
      aborted ? 'timeout' : 'network_error',
      aborted ? 'The request timed out' : 'Could not reach the server',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff with jitter, applied only to retryable failures. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError ? error.retryable : false;
      if (!retryable || attempt === attempts) break;

      const backoff = Math.min(4000, 400 * 2 ** (attempt - 1));
      const jitter = Math.random() * backoff;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }

  throw lastError;
}

export interface SubmitLeadResponse {
  ok: true;
  lead_id: string;
  event_id: string;
  status: 'accepted' | 'duplicate';
  qualification_outcome: string;
  persisted: boolean;
  jobs: { type: string; job_id: string; run_id: string }[];
  replayed?: boolean;
}

/**
 * Submit the lead.
 *
 * `idempotencyKey` is the conversion event_id, generated once when the user
 * first presses submit and reused across every retry. That single decision is
 * what makes an unreliable mobile network safe.
 */
export function submitLead(
  submission: LeadSubmission,
  idempotencyKey: string,
): Promise<SubmitLeadResponse> {
  return withRetry(() =>
    request<SubmitLeadResponse>('/api/leads', {
      method: 'POST',
      body: submission,
      headers: { 'idempotency-key': idempotencyKey },
      timeoutMs: 15_000,
    }),
  );
}

export interface EmailCaptureResponse {
  ok: true;
  event_id: string;
  duplicate: boolean;
}

export function captureEmail(body: {
  email: string;
  answers: Record<string, string | string[] | undefined>;
  attribution: Attribution;
  client: { session_id: string; event_id?: string; pixel_fired?: boolean };
}): Promise<EmailCaptureResponse> {
  return withRetry(
    () =>
      request<EmailCaptureResponse>('/api/leads/email', {
        method: 'POST',
        body,
        timeoutMs: 8000,
      }),
    2,
  );
}

export interface LeadStatusResponse {
  ok: true;
  lead_id: string;
  persisted: boolean;
  synced_to_crm: boolean;
  automation: { type: string; status: string; attempts: number; next_attempt_at?: string }[];
}

export function getLeadStatus(leadId: string): Promise<LeadStatusResponse> {
  return request<LeadStatusResponse>(`/api/leads/${leadId}/status`, { timeoutMs: 6000 });
}

/**
 * Fire-and-forget event beacon.
 *
 * Uses `sendBeacon` when available so an event fired as the user navigates away
 * still lands - a normal fetch is cancelled on unload, which is exactly when
 * drop-off events matter most.
 */
export async function postEvent(body: Record<string, unknown>): Promise<boolean> {
  const url = `${webEnv.apiBaseUrl}/api/events`;

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return true;
    } catch {
      // Fall through to fetch.
    }
  }

  try {
    await request('/api/events', { method: 'POST', body, timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface AdminMetrics {
  funnel: {
    visitors: number;
    qualification_started: number;
    funnel_started: number;
    qualification_completed: number;
    email_captured: number;
    lead_submitted: number;
    qualified: number;
    review: number;
    disqualified: number;
    conversion_rates: Record<string, number>;
  };
  automation: {
    meta_events_succeeded: number;
    meta_events_failed: number;
    airtable_writes_succeeded: number;
    airtable_writes_failed: number;
    retries_pending: number;
    dead_letter: number;
    duplicates_prevented: number;
    leads_awaiting_crm_sync: number;
    oldest_pending_job_age_seconds: number | null;
  };
  steps: { question_id: string; step_number: number; completions: number; drop_off_rate: number }[];
  integrations: Record<string, string>;
  failure_injection: Record<string, unknown>;
  generated_at: string;
}

function adminHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { 'x-admin-token': token } : {};
}

export function getAdminMetrics(): Promise<{ ok: true } & AdminMetrics> {
  return request(`/admin/metrics`, { headers: adminHeaders() });
}

export interface AdminJob {
  job_id: string;
  type: string;
  workflow: string;
  status: string;
  attempts: number;
  max_attempts: number;
  lead_id?: string;
  event_id?: string;
  dedupe_key: string;
  last_error?: string;
  next_attempt_at: string;
  updated_at: string;
}

export function getAdminJobs(): Promise<{ ok: true; jobs: AdminJob[] }> {
  return request(`/admin/jobs?limit=50`, { headers: adminHeaders() });
}

export interface AdminLead {
  lead_id: string;
  created_at: string;
  name: string;
  email_masked: string;
  lead_status: string;
  qualification_outcome: string;
  qualification_score: number;
  synced_to_crm: boolean;
  utm_source?: string;
  utm_campaign?: string;
  conversion_event_id: string;
}

export function getAdminLeads(): Promise<{ ok: true; leads: AdminLead[] }> {
  return request(`/admin/leads?limit=25`, { headers: adminHeaders() });
}

export function retryJob(jobId: string): Promise<{ ok: true; processed: unknown[] }> {
  return request(`/admin/jobs/${jobId}/retry`, {
    method: 'POST',
    headers: adminHeaders(),
    timeoutMs: 20_000,
  });
}

export function setFailureInjection(
  integration: 'airtable' | 'n8n' | 'meta',
  enabled: boolean,
): Promise<{ ok: true; failure_injection: Record<string, unknown> }> {
  return request(`/admin/failure-injection`, {
    method: 'POST',
    headers: adminHeaders(),
    body: { integration, enabled },
  });
}

export function drainOutbox(): Promise<{ ok: true; processed: unknown[] }> {
  return request(`/admin/outbox/drain`, {
    method: 'POST',
    headers: adminHeaders(),
    timeoutMs: 20_000,
  });
}
