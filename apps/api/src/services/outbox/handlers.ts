import type { FunnelEventName } from '@funnel/shared';
import { logger } from '../../lib/logger.js';
import { IntegrationError } from '../../lib/errors.js';
import { getQualificationAnswers, findLeadById, updateEvent, updateLead } from '../../store/repository.js';
import type { OutboxJob } from '../../store/types.js';
import { sendServerEvent } from '../meta/capi.js';
import { buildServerEvent, isEventTooOld, type BuildEventInput } from '../meta/payload.js';
import { buildLeadPayload, sendLeadToN8n } from '../n8n/client.js';

export interface HandlerResult {
  result: Record<string, unknown>;
}

/**
 * Deliver one server-side conversion to Meta.
 *
 * The payload was built at enqueue time and stored on the job, so a retry three
 * hours later sends byte-identical data with the same event_id - which is what
 * makes the retry safe rather than a source of double-counted conversions.
 */
export async function handleMetaCapiJob(job: OutboxJob): Promise<HandlerResult> {
  const input = job.payload as unknown as BuildEventInput & { eventTimeIso?: string };
  const eventTime = input.eventTimeIso ? new Date(input.eventTimeIso) : new Date();

  if (isEventTooOld(eventTime)) {
    // Meta would reject this. Fail permanently rather than burn retries.
    throw new IntegrationError('meta', 'Event older than Meta 7-day window', {
      retryable: false,
    });
  }

  const event = buildServerEvent({
    ...input,
    eventName: input.eventName as FunnelEventName,
    eventTime,
  });

  if (!event) {
    logger.info('outbox.meta_skipped_internal_event', { event_name: input.eventName });
    if (job.event_id) await updateEvent(job.event_id, { status: 'skipped' });
    return { result: { skipped: true, reason: 'internal_event' } };
  }

  const capi = await sendServerEvent(event);

  if (job.event_id) {
    await updateEvent(job.event_id, {
      status: 'sent',
      meta_delivered: capi.delivered,
    });
  }

  return {
    result: {
      delivered: capi.delivered,
      mocked: capi.mocked,
      events_received: capi.events_received,
      fbtrace_id: capi.fbtrace_id,
      event_id: capi.event_id,
    },
  };
}

/**
 * Push the lead through n8n into Airtable.
 *
 * The payload is rebuilt from the store on every attempt rather than frozen at
 * enqueue time: if an operator corrects a lead between attempts, the retry
 * should carry the corrected data. The idempotency key (lead_id) stays fixed,
 * so the workflow still recognises it as the same lead and updates rather than
 * inserts.
 */
export async function handleLeadToAirtableJob(job: OutboxJob): Promise<HandlerResult> {
  if (!job.lead_id) {
    throw new IntegrationError('n8n', 'Job is missing lead_id', { retryable: false });
  }

  const lead = await findLeadById(job.lead_id);
  if (!lead) {
    // Unrecoverable: the lead was deleted. Do not retry forever.
    throw new IntegrationError('n8n', `Lead ${job.lead_id} no longer exists`, {
      retryable: false,
    });
  }

  const answers = await getQualificationAnswers(job.lead_id);
  const payload = buildLeadPayload(lead, answers);
  const response = await sendLeadToN8n(payload);

  // Only now is the lead genuinely safe in the CRM.
  await updateLead(lead.lead_id, { synced_to_crm: true });

  return {
    result: {
      duplicate: response.duplicate ?? false,
      airtable_record_id: response.airtable_record_id,
      workflow: response.workflow,
    },
  };
}

export const JOB_HANDLERS = {
  meta_capi: handleMetaCapiJob,
  lead_to_airtable: handleLeadToAirtableJob,
} as const;
