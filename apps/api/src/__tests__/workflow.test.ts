import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { listenOnce } from './helpers.js';
import { resetStore } from '../store/repository.js';
import { resetMockAirtable, getMockAirtableSnapshot } from '../services/airtable/client.js';
import { setFailureInjection } from '../services/mockControl.js';
import { signPayload } from '../lib/hash.js';
import { executeLeadToAirtableWorkflow } from '../services/n8n/workflow.js';
import type { LeadWorkflowPayload } from '../services/n8n/workflow.js';

const app = createApp();
const server = listenOnce(app);

afterAll(() => {
  server.close();
});
const SECRET = 'test-secret';

function buildPayload(overrides: Partial<LeadWorkflowPayload> = {}): LeadWorkflowPayload {
  return {
    schema_version: 1,
    lead_id: 'ld_workflowtest01',
    event_id: 'evt_workflowtest001',
    created_at: new Date().toISOString(),
    funnel_version: 'qualification-v1',
    lead: {
      first_name: 'Dana',
      last_name: 'Whitfield',
      email: 'dana@example.com',
      phone: '14155550132',
      lead_status: 'qualified',
      qualification_outcome: 'qualified',
      qualification_score: 85,
      qualification_reasons: ['age_favourable_grid_rules'],
    },
    attribution: { source: 'facebook', campaign: 'ssdi_q3' },
    qualification: [
      { question_id: 'age_range', answer: '55_63', timestamp: new Date().toISOString() },
      { question_id: 'work_hours', answer: 'not_working', timestamp: new Date().toISOString() },
    ],
    ...overrides,
  };
}

/** Posts to the webhook with a correctly computed signature. */
function post(payload: unknown) {
  const body = JSON.stringify(payload);
  return request(server)
    .post('/mock/n8n/webhook/lead-to-airtable')
    .set('content-type', 'application/json')
    .set('x-funnel-signature', signPayload(body, SECRET))
    .send(body);
}

beforeEach(async () => {
  await resetStore();
  resetMockAirtable();
  setFailureInjection('airtable', false);
});

describe('n8n workflow: webhook security', () => {
  it('rejects an unsigned request', async () => {
    await request(server)
      .post('/mock/n8n/webhook/lead-to-airtable')
      .send(buildPayload())
      .expect(401);
  });

  it('rejects a wrong signature', async () => {
    await request(server)
      .post('/mock/n8n/webhook/lead-to-airtable')
      .set('x-funnel-signature', 'deadbeef')
      .send(buildPayload())
      .expect(401);
  });

  it('accepts a correctly signed request', async () => {
    const response = await post(buildPayload()).expect(200);
    expect(response.body.ok).toBe(true);
  });
});

describe('n8n workflow: validation', () => {
  it('rejects a malformed payload with a non-retryable 400', async () => {
    // 400 rather than 500 matters: the outbox reads the status to decide
    // whether a retry could ever help.
    const response = await post({ schema_version: 1, lead_id: 'x' }).expect(400);
    expect(response.body.ok).toBe(false);
  });

  it('rejects an unsupported schema version', async () => {
    const response = await post(buildPayload({ schema_version: 99 })).expect(400);
    expect(response.body.message).toMatch(/schema_version/);
  });

  it('rejects an invalid email', async () => {
    const payload = buildPayload();
    payload.lead.email = 'not-an-email';
    await post(payload).expect(400);
  });
});

describe('n8n workflow: idempotency', () => {
  it('creates the lead and its qualification rows on first delivery', async () => {
    const response = await post(buildPayload()).expect(200);

    expect(response.body.duplicate).toBe(false);
    expect(response.body.airtable_record_id).toMatch(/^rec/);

    const tables = getMockAirtableSnapshot();
    expect(tables.Leads).toBe(1);
    expect(tables.Qualification).toBe(2);
    expect(tables['Automation Runs']).toBe(1);
  });

  it('treats a replayed lead_id as a duplicate and does NOT insert again', async () => {
    const payload = buildPayload();

    const first = await post(payload).expect(200);
    const second = await post(payload).expect(200);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    // Same record, updated in place.
    expect(second.body.airtable_record_id).toBe(first.body.airtable_record_id);

    const tables = getMockAirtableSnapshot();
    expect(tables.Leads).toBe(1);
    // Qualification rows are not duplicated either.
    expect(tables.Qualification).toBe(2);
  });

  it('returns success (not an error) for a duplicate', async () => {
    // A replay is an expected outcome of an at-least-once delivery system. If
    // the workflow returned an error the outbox would retry forever.
    const payload = buildPayload();
    await post(payload).expect(200);

    const second = await post(payload).expect(200);
    expect(second.body.ok).toBe(true);
  });

  it('updates the stored record with the freshest data on replay', async () => {
    const payload = buildPayload();
    await post(payload).expect(200);

    const corrected = buildPayload();
    corrected.lead.qualification_outcome = 'review';
    corrected.lead.qualification_score = 55;
    await post(corrected).expect(200);

    // Still one record, now carrying the corrected values.
    expect(getMockAirtableSnapshot().Leads).toBe(1);
  });

  it('treats a different lead_id as a genuinely new lead', async () => {
    await post(buildPayload({ lead_id: 'ld_workflowtest01' })).expect(200);
    await post(buildPayload({ lead_id: 'ld_workflowtest02' })).expect(200);

    expect(getMockAirtableSnapshot().Leads).toBe(2);
  });

  it('logs an automation run for both the insert and the duplicate', async () => {
    const payload = buildPayload();
    await post(payload).expect(200);
    await post(payload).expect(200);

    // One 'succeeded' run plus one 'duplicate_ignored' run - the duplicate is
    // recorded, not silently swallowed.
    expect(getMockAirtableSnapshot()['Automation Runs']).toBe(2);
  });
});

describe('n8n workflow: downstream failure', () => {
  it('propagates an Airtable outage to the caller', async () => {
    setFailureInjection('airtable', true);
    await expect(executeLeadToAirtableWorkflow(buildPayload())).rejects.toThrow(/airtable/i);
    setFailureInjection('airtable', false);
  });

  it('writes nothing when the idempotency probe itself fails', async () => {
    setFailureInjection('airtable', true);
    await expect(executeLeadToAirtableWorkflow(buildPayload())).rejects.toThrow();
    setFailureInjection('airtable', false);

    // Critical: no partial write. Failing before the insert is what makes the
    // retry safe.
    expect(getMockAirtableSnapshot().Leads ?? 0).toBe(0);
  });
});
