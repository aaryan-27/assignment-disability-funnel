import { env, integrations } from '../../config/env.js';
import { IntegrationError } from '../../lib/errors.js';
import { fetchWithTimeout, readJsonResponse } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { signPayload } from '../../lib/hash.js';
import { mockLatency } from '../mockControl.js';
import { executeLeadToAirtableWorkflow, leadPayloadSchema } from './workflow.js';
import type { LeadRecord, QualificationRecord } from '../../store/types.js';

/**
 * The contract between this API and the n8n workflow.
 *
 * Versioned deliberately: n8n workflows are edited in a GUI by people who are
 * not necessarily reading this repo. A `schema_version` lets the workflow fail
 * loudly on an unexpected shape instead of silently writing empty columns.
 */
export const N8N_PAYLOAD_SCHEMA_VERSION = 1;

export interface N8nLeadPayload {
  schema_version: number;
  /** Idempotency key. The workflow must treat a repeat as a no-op. */
  lead_id: string;
  event_id: string;
  created_at: string;
  funnel_version: string;
  lead: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    lead_status: string;
    qualification_outcome: string;
    qualification_score: number;
    qualification_reasons: string[];
  };
  attribution: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
    fbclid?: string;
    landing_page?: string;
    referrer?: string;
  };
  /** One row per answered question - matches the Qualification table. */
  qualification: { question_id: string; answer: string; timestamp: string }[];
}

export interface N8nResponse {
  ok: boolean;
  /** True when the workflow recognised this as a replay. */
  duplicate?: boolean;
  airtable_record_id?: string;
  workflow?: string;
  message?: string;
}

export function buildLeadPayload(
  lead: LeadRecord,
  answers: QualificationRecord[],
): N8nLeadPayload {
  return {
    schema_version: N8N_PAYLOAD_SCHEMA_VERSION,
    lead_id: lead.lead_id,
    event_id: lead.conversion_event_id,
    created_at: lead.created_at,
    funnel_version: lead.funnel_version,
    lead: {
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      phone: lead.phone,
      lead_status: lead.lead_status,
      qualification_outcome: lead.qualification_outcome,
      qualification_score: lead.qualification_score,
      qualification_reasons: lead.qualification_reasons,
    },
    attribution: {
      source: lead.attribution.utm_source,
      medium: lead.attribution.utm_medium,
      campaign: lead.attribution.utm_campaign,
      content: lead.attribution.utm_content,
      term: lead.attribution.utm_term,
      fbclid: lead.attribution.fbclid,
      landing_page: lead.attribution.landing_page,
      referrer: lead.attribution.referrer,
    },
    qualification: answers.map((row) => ({
      question_id: row.question_id,
      answer: row.answer,
      timestamp: row.timestamp,
    })),
  };
}

/**
 * POST the lead to n8n.
 *
 * The body is signed with a shared secret so the webhook cannot be driven by
 * anyone who happens to discover the URL - n8n webhook URLs are unauthenticated
 * by default, which is a genuinely common production hole.
 */
export async function sendLeadToN8n(payload: N8nLeadPayload): Promise<N8nResponse> {
  if (integrations.n8n.mock) {
    await mockLatency();
    logger.info('n8n.mock_send', {
      lead_id: payload.lead_id,
      event_id: payload.event_id,
      answers: payload.qualification,
    });

    // Run the real workflow in-process rather than returning a canned success.
    // This is what makes mock mode worth having: the idempotency check runs,
    // the (mock) Airtable tables are actually written, and MOCK_AIRTABLE_FAILURE
    // propagates up through the workflow exactly as a real outage would.
    const parsed = leadPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IntegrationError('n8n', 'Mock workflow rejected the payload', {
        retryable: false,
      });
    }

    return executeLeadToAirtableWorkflow(parsed.data);
  }

  const body = JSON.stringify(payload);
  const response = await fetchWithTimeout(
    env.N8N_WEBHOOK_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-funnel-signature': signPayload(body, env.N8N_WEBHOOK_SECRET),
        // Standard header so n8n (or a proxy in front of it) can dedupe too.
        'x-idempotency-key': payload.lead_id,
      },
      body,
    },
    env.N8N_TIMEOUT_MS,
    'n8n',
  );

  const parsed = await readJsonResponse<N8nResponse>(response, 'n8n');

  if (parsed.ok === false) {
    throw new IntegrationError('n8n', parsed.message ?? 'Workflow reported failure', {
      retryable: true,
    });
  }

  logger.info('n8n.sent', {
    lead_id: payload.lead_id,
    duplicate: parsed.duplicate ?? false,
    airtable_record_id: parsed.airtable_record_id,
  });

  return parsed;
}
