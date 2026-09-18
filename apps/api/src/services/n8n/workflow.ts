import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import {
  AIRTABLE_TABLES,
  createRecord,
  createRecords,
  findRecordByField,
  updateRecord,
} from '../airtable/client.js';
import type { N8nResponse } from './client.js';

/**
 * The lead_to_airtable workflow, as executable code.
 *
 * This is the single source of truth for what the n8n workflow does. It is used
 * by two callers:
 *
 *   1. `routes/mockN8n.ts`  - exposes it over HTTP, so the real client can call
 *                             it exactly as it would call a live n8n instance.
 *   2. `services/n8n/client.ts` - calls it directly when n8n itself is mocked.
 *
 * Keeping one implementation means the idempotency behaviour is covered by
 * tests rather than living only inside a GUI-authored workflow that nothing can
 * exercise. `n8n/lead-to-airtable.workflow.json` is the importable mirror of
 * these same steps.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export const leadPayloadSchema = z.object({
  schema_version: z.number(),
  lead_id: z.string().min(3),
  event_id: z.string().min(3),
  created_at: z.string(),
  funnel_version: z.string(),
  lead: z.object({
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().email(),
    phone: z.string(),
    lead_status: z.string(),
    qualification_outcome: z.string(),
    qualification_score: z.number(),
    qualification_reasons: z.array(z.string()).default([]),
  }),
  attribution: z.record(z.string(), z.string().optional()).default({}),
  qualification: z
    .array(
      z.object({
        question_id: z.string(),
        answer: z.string(),
        timestamp: z.string(),
      }),
    )
    .default([]),
});

export type LeadWorkflowPayload = z.infer<typeof leadPayloadSchema>;

/**
 * Run the workflow.
 *
 * Idempotent on `lead_id`: a replay updates the existing record and returns
 * `duplicate: true` with a success status. A replay is a success, not an error -
 * getting that wrong is what turns a safe retry into an infinite failure loop.
 */
export async function executeLeadToAirtableWorkflow(
  payload: LeadWorkflowPayload,
): Promise<N8nResponse> {
  const startedAt = Date.now();

  // --- Node: check idempotency ---------------------------------------------
  // Airtable has no unique constraints, so the check must be explicit and it
  // must happen before any write.
  const existing = await findRecordByField(AIRTABLE_TABLES.leads(), 'lead_id', payload.lead_id);

  if (existing) {
    await updateRecord(AIRTABLE_TABLES.leads(), existing.id, {
      lead_status: payload.lead.lead_status,
      qualification_outcome: payload.lead.qualification_outcome,
      qualification_score: payload.lead.qualification_score,
      last_synced_at: new Date().toISOString(),
    });

    await createRecord(AIRTABLE_TABLES.automationRuns(), {
      lead_id: payload.lead_id,
      event_id: payload.event_id,
      workflow: 'lead_to_airtable',
      status: 'duplicate_ignored',
      retry_count: 0,
      last_attempt: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
    });

    logger.info('n8n_workflow.duplicate_ignored', {
      lead_id: payload.lead_id,
      airtable_record_id: existing.id,
    });

    return {
      ok: true,
      duplicate: true,
      airtable_record_id: existing.id,
      workflow: 'lead_to_airtable',
    };
  }

  // --- Node: transform ------------------------------------------------------
  const attribution = payload.attribution as Record<string, string | undefined>;
  const leadFields = {
    lead_id: payload.lead_id,
    created_at: payload.created_at,
    first_name: payload.lead.first_name,
    last_name: payload.lead.last_name,
    email: payload.lead.email,
    phone: payload.lead.phone,
    funnel_version: payload.funnel_version,
    source: attribution.source ?? 'direct',
    medium: attribution.medium ?? '',
    campaign: attribution.campaign ?? '',
    content: attribution.content ?? '',
    term: attribution.term ?? '',
    fbclid: attribution.fbclid ?? '',
    landing_page: attribution.landing_page ?? '',
    referrer: attribution.referrer ?? '',
    lead_status: payload.lead.lead_status,
    qualification_outcome: payload.lead.qualification_outcome,
    qualification_score: payload.lead.qualification_score,
    qualification_reasons: payload.lead.qualification_reasons.join(', '),
    conversion_event_id: payload.event_id,
    last_synced_at: new Date().toISOString(),
  };

  // --- Node: create the Leads record ---------------------------------------
  const created = await createRecord(AIRTABLE_TABLES.leads(), leadFields);

  // --- Node: create the Qualification rows ---------------------------------
  if (payload.qualification.length > 0) {
    await createRecords(
      AIRTABLE_TABLES.qualification(),
      payload.qualification.map((row) => ({
        lead_id: payload.lead_id,
        question_id: row.question_id,
        answer: row.answer,
        timestamp: row.timestamp,
      })),
    );
  }

  // --- Node: log the execution ---------------------------------------------
  await createRecord(AIRTABLE_TABLES.automationRuns(), {
    lead_id: payload.lead_id,
    event_id: payload.event_id,
    workflow: 'lead_to_airtable',
    status: 'succeeded',
    retry_count: 0,
    last_attempt: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
  });

  logger.info('n8n_workflow.lead_written', {
    lead_id: payload.lead_id,
    airtable_record_id: created.id,
    qualification_rows: payload.qualification.length,
    duration_ms: Date.now() - startedAt,
  });

  return {
    ok: true,
    duplicate: false,
    airtable_record_id: created.id,
    workflow: 'lead_to_airtable',
  };
}
