import {
  auditAnswers,
  CONTACT_STEP_IDS,
  evaluateQualification,
  funnelConfig,
  isFunnelComplete,
  isReportableConversion,
  newEventId,
  newLeadId,
  type FunnelAnswers,
  type LeadSubmission,
} from '@funnel/shared';
import { env } from '../config/env.js';
import { sha256 } from '../lib/hash.js';
import { logger } from '../lib/logger.js';
import {
  enqueueJob,
  findIdempotencyRecord,
  incrementCounter,
  findLeadByEmail,
  insertEventIfNew,
  insertLead,
  replaceQualificationAnswers,
  saveIdempotencyRecord,
} from '../store/repository.js';
import type { LeadRecord } from '../store/types.js';
import type { BuildEventInput } from './meta/payload.js';

/**
 * Modelled value of a lead, in USD, by outcome.
 *
 * Sending a `value` teaches Meta's bidding which conversions are worth more, so
 * it optimises toward qualified leads rather than raw volume. These are
 * placeholder economics - in production they come from the CRM's closed-won
 * data, not from a constant.
 */
const LEAD_VALUE_BY_OUTCOME: Record<string, number> = {
  qualified: 120,
  review: 45,
  disqualified: 0,
};

export interface CreateLeadContext {
  clientIp?: string;
  userAgent?: string;
}

export interface CreateLeadResult {
  lead_id: string;
  event_id: string;
  /** What the UI is allowed to tell the user. */
  status: 'accepted' | 'duplicate';
  qualification_outcome: string;
  /** True when the lead is committed to our store (not yet the CRM). */
  persisted: boolean;
  /** Jobs the caller can poll / retry. */
  jobs: { type: string; job_id: string; run_id: string }[];
  /** Present when the submission replayed an earlier one. */
  replayed?: boolean;
}

/**
 * Create a lead.
 *
 * Ordering is deliberate and is the heart of the reliability design:
 *
 *   1. Validate and re-derive everything server-side.
 *   2. Commit the lead + answers to our own store. After this point the lead
 *      cannot be lost, whatever any third party does.
 *   3. Enqueue side effects (Meta CAPI, n8n -> Airtable) in the outbox.
 *   4. Return. The worker delivers asynchronously with retries.
 *
 * The response never claims the CRM write succeeded, because at step 4 it has
 * not happened yet. The UI reflects exactly this distinction.
 */
export async function createLead(
  submission: LeadSubmission,
  context: CreateLeadContext,
): Promise<CreateLeadResult> {
  const { contact, answers, attribution, client } = submission;

  // --- Idempotency ---------------------------------------------------------
  // Key precedence: explicit header/body key, else the browser's event_id.
  // A retried submission after a flaky network must not create a second lead
  // or a second Meta conversion.
  const idempotencyKey = submission.idempotency_key ?? client.event_id;

  if (idempotencyKey) {
    const existing = await findIdempotencyRecord(idempotencyKey);
    if (existing) {
      // An idempotent replay is the most valuable kind of prevented duplicate:
      // without the key this would have been a second lead AND a second Meta
      // conversion. Count it so the dashboard can prove the mechanism works.
      await incrementCounter('duplicate_leads_prevented');

      logger.info('lead.idempotent_replay', {
        idempotency_key: idempotencyKey,
        lead_id: existing.lead_id,
      });
      return { ...(existing.response as unknown as CreateLeadResult), replayed: true };
    }
  }

  // --- Server-side audit of the answers ------------------------------------
  // The client controls the funnel UI; it does not control what we accept.
  const audit = auditAnswers(funnelConfig, answers as FunnelAnswers);
  if (audit.issues.length > 0) {
    // Issues are ids only, never answer values - safe to log.
    logger.warn('lead.answer_audit_issues', { issues: audit.issues });
  }

  const cleanAnswers = audit.accepted;
  const qualification = evaluateQualification(cleanAnswers);
  const complete = isFunnelComplete(funnelConfig, cleanAnswers);

  // --- Soft duplicate detection --------------------------------------------
  // Same email inside the dedup window is a re-submission, not a new lead.
  // We still store it (the operator may want to see the second attempt) but we
  // do not fire a second conversion to Meta.
  const priorLead = await findLeadByEmail(contact.email);
  const isRepeatPerson = Boolean(priorLead);

  const leadId = newLeadId();
  // Prefer the browser's event_id so the Pixel copy and this server copy share
  // a dedup key. Only mint a new one when the browser never produced one.
  const conversionEventId = client.event_id ?? newEventId();
  const timestamp = new Date().toISOString();

  const lead: LeadRecord = {
    lead_id: leadId,
    created_at: timestamp,
    updated_at: timestamp,
    first_name: contact.first_name,
    last_name: contact.last_name,
    email: contact.email,
    phone: contact.phone,
    funnel_version: attribution.funnel_version || env.FUNNEL_VERSION,
    lead_status: isRepeatPerson ? 'duplicate' : (qualification.outcome as LeadRecord['lead_status']),
    qualification_outcome: qualification.outcome,
    qualification_score: qualification.score,
    qualification_reasons: qualification.reasons,
    session_id: client.session_id,
    conversion_event_id: conversionEventId,
    attribution,
    // The raw IP is used once, for the Meta call, then discarded. We keep only
    // a hash so abuse analysis stays possible without retaining the address.
    client_ip_hash: context.clientIp ? sha256(context.clientIp) : undefined,
    client_user_agent: context.userAgent,
    synced_to_crm: false,
  };

  await insertLead(lead);

  // The contact-capture steps are answers in the funnel's eyes, but they are
  // identity data, not qualification data. They already live as first-class
  // columns on the lead, so writing them into the answers table would duplicate
  // PII into the one table that holds health information - exactly the table
  // that should be most tightly scoped.
  const qualificationAnswers = Object.fromEntries(
    Object.entries(cleanAnswers).filter(
      ([questionId]) => !CONTACT_STEP_IDS.includes(questionId as never),
    ),
  );
  await replaceQualificationAnswers(leadId, qualificationAnswers);

  logger.info('lead.created', {
    lead_id: leadId,
    event_id: conversionEventId,
    outcome: qualification.outcome,
    score: qualification.score,
    funnel_complete: complete,
    repeat_person: isRepeatPerson,
    utm_source: attribution.utm_source,
    utm_campaign: attribution.utm_campaign,
  });

  const jobs: CreateLeadResult['jobs'] = [];

  // --- Side effect 1: Meta conversion --------------------------------------
  const reportable = isReportableConversion(qualification.outcome) && !isRepeatPerson;

  const { event, duplicate: duplicateEvent } = await insertEventIfNew({
    event_id: conversionEventId,
    lead_id: leadId,
    session_id: client.session_id,
    event_name: 'Lead',
    timestamp,
    source: 'server',
    status: reportable ? 'received' : 'skipped',
    pixel_fired: client.pixel_fired ?? false,
    step_number: undefined,
  });

  if (reportable && !duplicateEvent) {
    const metaPayload: BuildEventInput & { eventTimeIso: string } = {
      eventName: 'Lead',
      eventId: conversionEventId,
      eventTimeIso: timestamp,
      email: contact.email,
      phone: contact.phone,
      firstName: contact.first_name,
      lastName: contact.last_name,
      // `gender` is the only questionnaire answer permitted to reach Meta, and
      // only as a hashed Advanced Matching key - never as a custom parameter.
      gender: typeof cleanAnswers.gender === 'string' ? cleanAnswers.gender : undefined,
      fbp: attribution.fbp,
      fbc: attribution.fbc,
      fbclid: attribution.fbclid,
      clientIp: context.clientIp,
      userAgent: context.userAgent ?? client.user_agent,
      sourceUrl: attribution.landing_page,
      qualificationOutcome: qualification.outcome,
      value: LEAD_VALUE_BY_OUTCOME[qualification.outcome] ?? 0,
    };

    const metaJob = await enqueueJob({
      type: 'meta_capi',
      dedupe_key: `meta:${conversionEventId}`,
      payload: metaPayload as unknown as Record<string, unknown>,
      lead_id: leadId,
      event_id: conversionEventId,
      workflow: 'meta_capi_lead',
    });
    jobs.push({ type: 'meta_capi', job_id: metaJob.job.job_id, run_id: metaJob.job.run_id });
  } else {
    logger.info('lead.meta_conversion_suppressed', {
      lead_id: leadId,
      reason: isRepeatPerson ? 'repeat_person' : 'not_reportable_outcome',
      outcome: qualification.outcome,
    });
  }

  void event;

  // --- Side effect 2: CRM sync (always, even for disqualified leads) --------
  // A disqualified lead is still a lead the business wants to see. Only the ad
  // platform is spared it.
  const crmJob = await enqueueJob({
    type: 'lead_to_airtable',
    dedupe_key: `airtable:${leadId}`,
    payload: { lead_id: leadId },
    lead_id: leadId,
    event_id: conversionEventId,
    workflow: 'lead_to_airtable',
  });
  jobs.push({ type: 'lead_to_airtable', job_id: crmJob.job.job_id, run_id: crmJob.job.run_id });

  const result: CreateLeadResult = {
    lead_id: leadId,
    event_id: conversionEventId,
    status: isRepeatPerson ? 'duplicate' : 'accepted',
    qualification_outcome: qualification.outcome,
    persisted: true,
    jobs,
  };

  if (idempotencyKey) {
    await saveIdempotencyRecord({
      key: idempotencyKey,
      lead_id: leadId,
      created_at: timestamp,
      response: result as unknown as Record<string, unknown>,
    });
  }

  return result;
}

/**
 * Partial capture at the email step.
 *
 * Fired before the contact form because a meaningful share of users abandon
 * between email and phone. Capturing early converts a lost session into a
 * remarketable contact, and gives Meta a mid-funnel signal to optimise on.
 */
export async function captureEmail(
  input: {
    email: string;
    answers: FunnelAnswers;
    attribution: LeadSubmission['attribution'];
    client: LeadSubmission['client'];
  },
  context: CreateLeadContext,
): Promise<{ event_id: string; duplicate: boolean }> {
  const eventId = input.client.event_id ?? newEventId();
  const timestamp = new Date().toISOString();

  const { duplicate } = await insertEventIfNew({
    event_id: eventId,
    session_id: input.client.session_id,
    event_name: 'EmailCaptured',
    timestamp,
    source: 'server',
    status: 'received',
    pixel_fired: input.client.pixel_fired ?? false,
  });

  if (duplicate) {
    logger.info('email_capture.duplicate_ignored', { event_id: eventId });
    return { event_id: eventId, duplicate: true };
  }

  const audit = auditAnswers(funnelConfig, input.answers);
  const qualification = evaluateQualification(audit.accepted);

  const payload: BuildEventInput & { eventTimeIso: string } = {
    eventName: 'EmailCaptured',
    eventId,
    eventTimeIso: timestamp,
    email: input.email,
    gender:
      typeof audit.accepted.gender === 'string' ? audit.accepted.gender : undefined,
    fbp: input.attribution.fbp,
    fbc: input.attribution.fbc,
    fbclid: input.attribution.fbclid,
    clientIp: context.clientIp,
    userAgent: context.userAgent ?? input.client.user_agent,
    sourceUrl: input.attribution.landing_page,
    qualificationOutcome: qualification.outcome,
  };

  await enqueueJob({
    type: 'meta_capi',
    dedupe_key: `meta:${eventId}`,
    payload: payload as unknown as Record<string, unknown>,
    event_id: eventId,
    workflow: 'meta_capi_email_captured',
  });

  logger.info('email_capture.accepted', { event_id: eventId, outcome: qualification.outcome });
  return { event_id: eventId, duplicate: false };
}
