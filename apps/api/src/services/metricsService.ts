import { snapshot } from '../store/repository.js';
import { getFailureInjectionState } from './mockControl.js';
import { describeIntegrations } from '../config/env.js';
import { getMockAirtableSnapshot } from './airtable/client.js';

/**
 * Operational metrics.
 *
 * Two distinct questions get answered here, and conflating them is a common
 * mistake:
 *
 *   1. GROWTH  - where are people dropping out of the funnel?
 *   2. HEALTH  - is anything silently broken right now?
 *
 * Both are computed from the same event store, so the numbers an operator sees
 * are the numbers the system actually recorded - not a second, drifting copy.
 */

export interface FunnelMetrics {
  visitors: number;
  /** Saw question one. */
  qualification_started: number;
  /** Answered question one. */
  funnel_started: number;
  qualification_completed: number;
  email_captured: number;
  lead_submitted: number;
  qualified: number;
  review: number;
  disqualified: number;
  /** Step-by-step conversion, as percentages. */
  conversion_rates: {
    /** Rendered question one and actually answered it. The biggest single drop
     *  in a quiz funnel, and the one most often invisible. */
    render_to_engage: number;
    visit_to_start: number;
    start_to_email: number;
    email_to_lead: number;
    visit_to_lead: number;
    lead_qualification_rate: number;
  };
}

export interface AutomationMetrics {
  meta_events_succeeded: number;
  meta_events_failed: number;
  airtable_writes_succeeded: number;
  airtable_writes_failed: number;
  retries_pending: number;
  dead_letter: number;
  duplicates_prevented: number;
  leads_awaiting_crm_sync: number;
  oldest_pending_job_age_seconds: number | null;
}

export interface StepBreakdown {
  question_id: string;
  step_number: number;
  completions: number;
  /** Percent of users who reached this step and did not reach the next one. */
  drop_off_rate: number;
}

/**
 * Percentage, clamped to 100.
 *
 * The clamp is not cosmetic. Top-of-funnel counts come from browser beacons,
 * which can be lost to ad blockers, rate limits and users closing the tab
 * mid-request. Lead counts come from server-authoritative records and are never
 * lost. So a step rate can legitimately exceed 100% when a beacon went missing,
 * and rendering "118%" in an ops dashboard reads as a bug rather than as the
 * measurement artefact it is.
 */
function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

/** Distinct sessions that emitted any of `names`. */
function uniqueSessions(
  events: { event_name: string; session_id: string }[],
  ...names: string[]
): number {
  const wanted = new Set(names);
  const sessions = new Set<string>();
  for (const event of events) {
    if (wanted.has(event.event_name)) sessions.add(event.session_id);
  }
  return sessions.size;
}

export async function getMetrics(): Promise<{
  funnel: FunnelMetrics;
  automation: AutomationMetrics;
  steps: StepBreakdown[];
  integrations: Record<string, string>;
  failure_injection: Record<string, unknown>;
  mock_airtable_tables: Record<string, number>;
  generated_at: string;
}> {
  const data = await snapshot((db) => ({
    events: db.events.map((event) => ({
      event_name: event.event_name,
      session_id: event.session_id,
      status: event.status,
      step_number: event.step_number,
      question_id: event.question_id,
      meta_delivered: event.meta_delivered,
    })),
    leads: db.leads.map((lead) => ({
      outcome: lead.qualification_outcome,
      synced: lead.synced_to_crm,
    })),
    jobs: db.outbox.map((job) => ({
      type: job.type,
      status: job.status,
      created_at: job.created_at,
      next_attempt_at: job.next_attempt_at,
    })),
    counters: { ...db.counters },
  }));

  const { events, leads, jobs, counters } = data;

  // --- Funnel ---------------------------------------------------------------
  const visitors = uniqueSessions(events, 'PageView', 'ViewContent');
  const qualificationStarted = uniqueSessions(events, 'QualificationStarted');
  // A session that completed a question has definitionally started the funnel,
  // so counting both events makes the metric resilient to one lost beacon.
  const funnelStarted = uniqueSessions(events, 'FunnelStarted', 'QuestionCompleted');
  const qualificationCompleted = uniqueSessions(events, 'QualificationCompleted');
  const emailCaptured = uniqueSessions(events, 'EmailCaptured');
  const leadSubmitted = leads.length;

  const qualified = leads.filter((lead) => lead.outcome === 'qualified').length;
  const review = leads.filter((lead) => lead.outcome === 'review').length;
  const disqualified = leads.filter((lead) => lead.outcome === 'disqualified').length;

  const funnel: FunnelMetrics = {
    visitors,
    qualification_started: qualificationStarted,
    funnel_started: funnelStarted,
    qualification_completed: qualificationCompleted,
    email_captured: emailCaptured,
    lead_submitted: leadSubmitted,
    qualified,
    review,
    disqualified,
    conversion_rates: {
      render_to_engage: pct(funnelStarted, qualificationStarted),
      visit_to_start: pct(funnelStarted, visitors),
      start_to_email: pct(emailCaptured, funnelStarted),
      email_to_lead: pct(leadSubmitted, emailCaptured),
      visit_to_lead: pct(leadSubmitted, visitors),
      lead_qualification_rate: pct(qualified + review, leadSubmitted),
    },
  };

  // --- Automation health ----------------------------------------------------
  const metaJobs = jobs.filter((job) => job.type === 'meta_capi');
  const crmJobs = jobs.filter((job) => job.type === 'lead_to_airtable');

  const pendingJobs = jobs.filter(
    (job) => job.status === 'pending' || job.status === 'failed' || job.status === 'in_progress',
  );

  const oldestPending = pendingJobs.reduce<number | null>((oldest, job) => {
    const age = Date.now() - new Date(job.created_at).getTime();
    return oldest === null || age > oldest ? age : oldest;
  }, null);

  const automation: AutomationMetrics = {
    meta_events_succeeded: metaJobs.filter((job) => job.status === 'succeeded').length,
    meta_events_failed: metaJobs.filter(
      (job) => job.status === 'failed' || job.status === 'dead_letter',
    ).length,
    airtable_writes_succeeded: crmJobs.filter((job) => job.status === 'succeeded').length,
    airtable_writes_failed: crmJobs.filter(
      (job) => job.status === 'failed' || job.status === 'dead_letter',
    ).length,
    retries_pending: jobs.filter((job) => job.status === 'failed' || job.status === 'pending')
      .length,
    dead_letter: jobs.filter((job) => job.status === 'dead_letter').length,
    duplicates_prevented:
      (counters.duplicate_events_prevented ?? 0) +
      (counters.duplicate_jobs_prevented ?? 0) +
      (counters.duplicate_leads_prevented ?? 0),
    leads_awaiting_crm_sync: leads.filter((lead) => !lead.synced).length,
    oldest_pending_job_age_seconds:
      oldestPending === null ? null : Math.round(oldestPending / 1000),
  };

  // --- Per-step drop-off ----------------------------------------------------
  // Built from QuestionCompleted events, which are internal-only by design.
  const stepMap = new Map<string, { step: number; sessions: Set<string> }>();
  for (const event of events) {
    if (event.event_name !== 'QuestionCompleted' || !event.question_id) continue;
    const entry = stepMap.get(event.question_id) ?? {
      step: event.step_number ?? 0,
      sessions: new Set<string>(),
    };
    entry.sessions.add(event.session_id);
    stepMap.set(event.question_id, entry);
  }

  const ordered = [...stepMap.entries()].sort((a, b) => a[1].step - b[1].step);
  const steps: StepBreakdown[] = ordered.map(([questionId, entry], index) => {
    const completions = entry.sessions.size;
    const next = ordered[index + 1];
    const nextCompletions = next ? next[1].sessions.size : leadSubmitted;
    return {
      question_id: questionId,
      step_number: entry.step,
      completions,
      drop_off_rate: completions > 0 ? pct(completions - nextCompletions, completions) : 0,
    };
  });

  return {
    funnel,
    automation,
    steps,
    integrations: describeIntegrations(),
    failure_injection: getFailureInjectionState(),
    mock_airtable_tables: getMockAirtableSnapshot(),
    generated_at: new Date().toISOString(),
  };
}
