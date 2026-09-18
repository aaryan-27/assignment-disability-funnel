import { newRunId, newQualificationId, newJobId } from '@funnel/shared';
import { env } from '../config/env.js';
import { store } from './jsonStore.js';
import type {
  AutomationRun,
  DatabaseShape,
  EventRecord,
  IdempotencyRecord,
  LeadRecord,
  OutboxJob,
  OutboxJobType,
  QualificationRecord,
} from './types.js';

/**
 * The repository is the only module that knows how records are stored.
 * Routes and services depend on these functions, never on the store itself.
 */

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export async function insertLead(lead: LeadRecord): Promise<LeadRecord> {
  return store.transaction((db) => {
    db.leads.push(lead);
    return lead;
  });
}

export async function findLeadById(leadId: string): Promise<LeadRecord | undefined> {
  return store.read((db) => db.leads.find((lead) => lead.lead_id === leadId));
}

export async function findLeadByEmail(email: string): Promise<LeadRecord | undefined> {
  const needle = email.toLowerCase();
  return store.read((db) => db.leads.find((lead) => lead.email === needle));
}

export async function updateLead(
  leadId: string,
  patch: Partial<LeadRecord>,
): Promise<LeadRecord | undefined> {
  return store.transaction((db) => {
    const lead = db.leads.find((item) => item.lead_id === leadId);
    if (!lead) return undefined;
    Object.assign(lead, patch, { updated_at: now() });
    return lead;
  });
}

export async function listLeads(limit = 50): Promise<LeadRecord[]> {
  return store.read((db) => [...db.leads].reverse().slice(0, limit));
}

// ---------------------------------------------------------------------------
// Qualification answers
// ---------------------------------------------------------------------------

/**
 * Answers are stored one row per question - an EAV shape.
 *
 * Why not one wide column per question? Because the funnel is config-driven:
 * adding question 16 must not require a schema migration in Airtable or here.
 * The cost is that reporting needs a pivot, which is the right trade for a
 * funnel that changes weekly.
 */
export async function replaceQualificationAnswers(
  leadId: string,
  answers: Record<string, string | string[] | undefined>,
): Promise<QualificationRecord[]> {
  const timestamp = now();
  const rows: QualificationRecord[] = Object.entries(answers)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([questionId, value]) => ({
      qualification_id: newQualificationId(),
      lead_id: leadId,
      question_id: questionId,
      answer: Array.isArray(value) ? value.join('|') : String(value),
      timestamp,
    }));

  return store.transaction((db) => {
    db.qualification = db.qualification.filter((row) => row.lead_id !== leadId);
    db.qualification.push(...rows);
    return rows;
  });
}

export async function getQualificationAnswers(leadId: string): Promise<QualificationRecord[]> {
  return store.read((db) => db.qualification.filter((row) => row.lead_id === leadId));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Insert an event, unless its event_id has already been recorded.
 *
 * Returns `duplicate: true` for a repeat, which is how the funnel counts
 * "duplicates prevented" - a real operational metric, not a vanity one.
 */
export async function insertEventIfNew(
  record: EventRecord,
): Promise<{ event: EventRecord; duplicate: boolean }> {
  return store.transaction((db) => {
    const existing = db.events.find((event) => event.event_id === record.event_id);
    if (existing) {
      db.counters.duplicate_events_prevented = (db.counters.duplicate_events_prevented ?? 0) + 1;
      return { event: existing, duplicate: true };
    }
    db.events.push(record);
    return { event: record, duplicate: false };
  });
}

export async function updateEvent(
  eventId: string,
  patch: Partial<EventRecord>,
): Promise<EventRecord | undefined> {
  return store.transaction((db) => {
    const event = db.events.find((item) => item.event_id === eventId);
    if (!event) return undefined;
    Object.assign(event, patch);
    return event;
  });
}

export async function listEvents(limit = 100): Promise<EventRecord[]> {
  return store.read((db) => [...db.events].reverse().slice(0, limit));
}

export async function countEventsByName(eventName: string): Promise<number> {
  return store.read((db) => db.events.filter((event) => event.event_name === eventName).length);
}

// ---------------------------------------------------------------------------
// Automation runs
// ---------------------------------------------------------------------------

export async function createAutomationRun(
  input: Omit<AutomationRun, 'run_id' | 'created_at' | 'updated_at' | 'retry_count'> &
    Partial<Pick<AutomationRun, 'retry_count'>>,
): Promise<AutomationRun> {
  const record: AutomationRun = {
    run_id: newRunId(),
    retry_count: input.retry_count ?? 0,
    created_at: now(),
    updated_at: now(),
    ...input,
  };
  return store.transaction((db) => {
    db.automation_runs.push(record);
    return record;
  });
}

export async function updateAutomationRun(
  runId: string,
  patch: Partial<AutomationRun>,
): Promise<AutomationRun | undefined> {
  return store.transaction((db) => {
    const run = db.automation_runs.find((item) => item.run_id === runId);
    if (!run) return undefined;
    Object.assign(run, patch, { updated_at: now() });
    return run;
  });
}

export async function listAutomationRuns(limit = 50): Promise<AutomationRun[]> {
  return store.read((db) => [...db.automation_runs].reverse().slice(0, limit));
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  type: OutboxJobType;
  dedupe_key: string;
  payload: Record<string, unknown>;
  lead_id?: string;
  event_id?: string;
  workflow: string;
}

/**
 * Enqueue a side effect.
 *
 * The lead row is already committed by the time this runs. If the process dies
 * here, the job is simply missing and the admin view shows a lead with no
 * automation run - visible, and replayable from the UI. If instead we had
 * called Meta and n8n inline, a crash would lose the lead entirely.
 *
 * Enqueue is itself idempotent on `dedupe_key`, so a retried HTTP request never
 * produces two jobs for the same conversion.
 */
export async function enqueueJob(
  input: EnqueueInput,
): Promise<{ job: OutboxJob; run: AutomationRun; duplicate: boolean }> {
  return store.transaction((db) => {
    const existing = db.outbox.find(
      (job) => job.dedupe_key === input.dedupe_key && job.type === input.type,
    );
    if (existing) {
      db.counters.duplicate_jobs_prevented = (db.counters.duplicate_jobs_prevented ?? 0) + 1;
      const existingRun =
        db.automation_runs.find((run) => run.run_id === existing.run_id) ??
        ({} as AutomationRun);
      return { job: existing, run: existingRun, duplicate: true };
    }

    const timestamp = now();
    const run: AutomationRun = {
      run_id: newRunId(),
      lead_id: input.lead_id,
      event_id: input.event_id,
      workflow: input.workflow,
      status: 'pending',
      retry_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };

    const job: OutboxJob = {
      job_id: newJobId(),
      type: input.type,
      workflow: input.workflow,
      dedupe_key: input.dedupe_key,
      lead_id: input.lead_id,
      event_id: input.event_id,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      max_attempts: env.OUTBOX_MAX_ATTEMPTS,
      next_attempt_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      run_id: run.run_id,
    };

    db.automation_runs.push(run);
    db.outbox.push(job);
    return { job, run, duplicate: false };
  });
}

/**
 * Atomically claim the next due job.
 *
 * Claiming (pending -> in_progress) inside the same transaction as the read is
 * what stops two worker ticks from processing the same job concurrently.
 *
 * `exclude` holds jobs already attempted in the current drain pass, so one pass
 * can never retry the same job twice however short its backoff turned out.
 */
export async function claimNextJob(exclude?: ReadonlySet<string>): Promise<OutboxJob | undefined> {
  const timestamp = Date.now();
  return store.transaction((db) => {
    const job = db.outbox.find(
      (item) =>
        (item.status === 'pending' || item.status === 'failed') &&
        !exclude?.has(item.job_id) &&
        new Date(item.next_attempt_at).getTime() <= timestamp,
    );
    if (!job) return undefined;
    job.status = 'in_progress';
    job.attempts += 1;
    job.updated_at = now();
    return job;
  });
}

export async function updateJob(
  jobId: string,
  patch: Partial<OutboxJob>,
): Promise<OutboxJob | undefined> {
  return store.transaction((db) => {
    const job = db.outbox.find((item) => item.job_id === jobId);
    if (!job) return undefined;
    Object.assign(job, patch, { updated_at: now() });
    return job;
  });
}

export async function findJob(jobId: string): Promise<OutboxJob | undefined> {
  return store.read((db) => db.outbox.find((job) => job.job_id === jobId));
}

export async function listJobs(limit = 50): Promise<OutboxJob[]> {
  return store.read((db) => [...db.outbox].reverse().slice(0, limit));
}

/** Reset a dead-lettered or failed job so the worker picks it up again. */
export async function requeueJob(jobId: string): Promise<OutboxJob | undefined> {
  return store.transaction((db) => {
    const job = db.outbox.find((item) => item.job_id === jobId);
    if (!job) return undefined;
    if (job.status === 'succeeded') return job;
    job.status = 'pending';
    job.next_attempt_at = now();
    job.max_attempts = job.attempts + env.OUTBOX_MAX_ATTEMPTS;
    job.updated_at = now();
    return job;
  });
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export async function findIdempotencyRecord(
  key: string,
): Promise<IdempotencyRecord | undefined> {
  return store.read((db) => db.idempotency.find((record) => record.key === key));
}

export async function saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
  await store.transaction((db) => {
    if (db.idempotency.some((item) => item.key === record.key)) return;
    db.idempotency.push(record);
  });
}

// ---------------------------------------------------------------------------
// Counters + aggregate reads
// ---------------------------------------------------------------------------

export async function incrementCounter(name: string, by = 1): Promise<void> {
  await store.transaction((db) => {
    db.counters[name] = (db.counters[name] ?? 0) + by;
  });
}

export async function snapshot<T>(fn: (db: DatabaseShape) => T): Promise<T> {
  return store.read(fn);
}

export async function resetStore(): Promise<void> {
  await store.reset();
}
