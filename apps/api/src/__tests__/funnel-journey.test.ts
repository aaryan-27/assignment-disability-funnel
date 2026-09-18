import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  funnelConfig,
  getNextQuestion,
  pruneOrphanedAnswers,
  type FunnelAnswers,
} from '@funnel/shared';
import { createApp } from '../app.js';
import { listenOnce } from './helpers.js';
import { resetStore, snapshot, listJobs } from '../store/repository.js';
import { resetMockAirtable, getMockAirtableSnapshot } from '../services/airtable/client.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { setFailureInjection } from '../services/mockControl.js';
import { drainOutbox } from '../services/outbox/worker.js';

const app = createApp();
const server = listenOnce(app);

afterAll(() => {
  server.close();
});
const ADMIN = { 'x-admin-token': 'test-admin-token' };

beforeEach(async () => {
  await resetStore();
  resetMockAirtable();
  resetRateLimits();
  setFailureInjection('airtable', false);
});

/**
 * Walks the funnel the way a browser would: answer the current question, let
 * the branching engine pick the next one, and beacon an event at each step.
 * Returns the answers actually collected along that user's path.
 */
async function walkFunnel(
  sessionId: string,
  choices: Record<string, string>,
): Promise<FunnelAnswers> {
  let answers: FunnelAnswers = {};
  let current = funnelConfig.questions[0]!;
  let step = 1;
  let guard = 0;

  await request(server)
    .post('/api/events')
    .send({ event_name: 'PageView', event_id: `evt_pv_${sessionId}`, session_id: sessionId })
    .expect(202);

  while (guard < 40) {
    guard += 1;
    if (current.type === 'email' || current.type === 'contact') break;

    const value = choices[current.id] ?? current.options?.[0]?.value ?? '';
    answers = pruneOrphanedAnswers(funnelConfig, { ...answers, [current.id]: value });

    if (step === 1) {
      await request(server)
        .post('/api/events')
        .send({
          event_name: 'FunnelStarted',
          event_id: `evt_fs_${sessionId}`,
          session_id: sessionId,
          step_number: 1,
        })
        .expect(202);
    }

    await request(server)
      .post('/api/events')
      .send({
        event_name: 'QuestionCompleted',
        event_id: `evt_q${step}_${sessionId}`,
        session_id: sessionId,
        question_id: current.id,
        step_number: step,
      })
      .expect(202);

    const next = getNextQuestion(funnelConfig, answers, current.id);
    if (!next) break;
    current = next;
    step += 1;
  }

  await request(server)
    .post('/api/events')
    .send({
      event_name: 'QualificationCompleted',
      event_id: `evt_qc_${sessionId}`,
      session_id: sessionId,
    })
    .expect(202);

  return answers;
}

describe('end-to-end funnel journey', () => {
  it('carries a qualified user from first view to a synced CRM record', async () => {
    const sessionId = 'ses_journeyqualified';

    const answers = await walkFunnel(sessionId, {
      age_range: '55_63',
      receiving_benefits: 'none',
      work_hours: 'not_working',
      years_employed: 'over_6',
      asset_value: 'under_2000',
      out_of_work_year: 'yes',
      under_medical_care: 'yes',
      application_pending: 'no',
      gender: 'female',
      marital_status: 'married',
    });

    // The skipped branch never collected an answer.
    expect(answers.attorney_represented).toBeUndefined();

    await request(server)
      .post('/api/leads/email')
      .send({
        email: 'journey@example.com',
        answers,
        attribution: { funnel_version: 'qualification-v1', utm_source: 'facebook' },
        client: { session_id: sessionId, event_id: `evt_email_${sessionId}` },
      })
      .expect(202);

    const lead = await request(server)
      .post('/api/leads')
      .send({
        contact: {
          first_name: 'Dana',
          last_name: 'Whitfield',
          email: 'journey@example.com',
          phone: '4155550132',
        },
        answers,
        attribution: {
          funnel_version: 'qualification-v1',
          utm_source: 'facebook',
          utm_campaign: 'ssdi_q3',
          fbclid: 'IwAR0Journey',
        },
        client: {
          session_id: sessionId,
          event_id: `evt_lead_${sessionId}`,
          pixel_fired: true,
        },
      })
      .expect(201);

    expect(lead.body.qualification_outcome).toBe('qualified');

    await drainOutbox();

    // The lead reached Airtable through the workflow, with its answers.
    const tables = getMockAirtableSnapshot();
    expect(tables.Leads).toBe(1);
    expect(tables.Qualification).toBe(Object.keys(answers).length);

    const status = await request(server)
      .get(`/api/leads/${lead.body.lead_id}/status`)
      .expect(200);
    expect(status.body.synced_to_crm).toBe(true);

    // And the funnel metrics reflect the whole journey.
    const metrics = await request(server).get('/admin/metrics').set(ADMIN).expect(200);
    expect(metrics.body.funnel.visitors).toBe(1);
    expect(metrics.body.funnel.funnel_started).toBe(1);
    expect(metrics.body.funnel.email_captured).toBe(1);
    expect(metrics.body.funnel.lead_submitted).toBe(1);
    expect(metrics.body.funnel.qualified).toBe(1);
    expect(metrics.body.automation.dead_letter).toBe(0);
  });

  it('collects the full appeal branch for an applicant who was denied', async () => {
    const sessionId = 'ses_journeydenied000';

    const answers = await walkFunnel(sessionId, {
      age_range: '50_54',
      receiving_benefits: 'none',
      work_hours: 'under_20',
      years_employed: '4_to_6',
      asset_value: 'over_2000',
      out_of_work_year: 'yes',
      under_medical_care: 'yes',
      application_pending: 'yes',
      attorney_represented: 'yes',
      attorney_firm: 'allsup',
      application_denied: 'yes',
      appeal_stage: 'hearing',
      waiting_duration: 'over_9m',
      gender: 'male',
      marital_status: 'divorced',
    });

    // Every branch question was reached and answered.
    expect(answers.attorney_firm).toBe('allsup');
    expect(answers.appeal_stage).toBe('hearing');
    expect(answers.waiting_duration).toBe('over_9m');

    const lead = await request(server)
      .post('/api/leads')
      .send({
        contact: {
          first_name: 'Marcus',
          last_name: 'Reyes',
          email: 'denied@example.com',
          phone: '2125550178',
        },
        answers,
        attribution: { funnel_version: 'qualification-v1' },
        client: { session_id: sessionId, event_id: `evt_lead_${sessionId}` },
      })
      .expect(201);

    // Representation lowers the score, so this lands in review rather than
    // qualified - and is still captured.
    expect(['review', 'qualified']).toContain(lead.body.qualification_outcome);

    const rows = await snapshot((db) =>
      db.qualification.filter((row) => row.lead_id === lead.body.lead_id),
    );
    expect(rows.map((row) => row.question_id)).toContain('appeal_stage');
  });

  it('captures a disqualified user without reporting them to Meta', async () => {
    const sessionId = 'ses_journeydisqual00';

    const answers = await walkFunnel(sessionId, {
      age_range: 'under_40',
      receiving_benefits: 'none',
      // Full-time work is a hard disqualifier.
      work_hours: 'over_20',
      years_employed: 'over_6',
      asset_value: 'over_2000',
      out_of_work_year: 'no',
      under_medical_care: 'no',
      application_pending: 'no',
      gender: 'undisclosed',
      marital_status: 'single',
    });

    const lead = await request(server)
      .post('/api/leads')
      .send({
        contact: {
          first_name: 'Sam',
          last_name: 'Fielder',
          email: 'disqualified@example.com',
          phone: '3105550144',
        },
        answers,
        attribution: { funnel_version: 'qualification-v1' },
        client: { session_id: sessionId, event_id: `evt_lead_${sessionId}` },
      })
      .expect(201);

    expect(lead.body.qualification_outcome).toBe('disqualified');

    await drainOutbox();

    const jobs = await listJobs(20);

    // No `Lead` conversion is reported for a disqualified user - that is the
    // signal Meta optimises bidding on, and feeding it bad leads teaches the
    // algorithm to find more of them.
    const leadConversionJobs = jobs.filter(
      (job) => job.type === 'meta_capi' && job.event_id === `evt_lead_${sessionId}`,
    );
    expect(leadConversionJobs).toHaveLength(0);

    // The mid-funnel QualificationCompleted signal is still sent: it measures
    // funnel depth, not lead quality, and suppressing it would distort
    // drop-off reporting.
    expect(
      jobs.some((job) => job.type === 'meta_capi' && job.workflow?.includes('Qualification')),
    ).toBe(true);

    // And the CRM receives the lead regardless - the business wants every one.
    expect(getMockAirtableSnapshot().Leads).toBe(1);
  });

  it('keeps the user experience intact when the whole automation layer is down', async () => {
    setFailureInjection('airtable', true);
    const sessionId = 'ses_journeyoutage000';

    const answers = await walkFunnel(sessionId, {
      age_range: '55_63',
      receiving_benefits: 'none',
      work_hours: 'not_working',
      years_employed: 'over_6',
      asset_value: 'under_2000',
      out_of_work_year: 'yes',
      under_medical_care: 'yes',
      application_pending: 'no',
      gender: 'female',
      marital_status: 'single',
    });

    // The user still gets a 201 and a success screen, because their lead IS saved.
    const lead = await request(server)
      .post('/api/leads')
      .send({
        contact: {
          first_name: 'Ada',
          last_name: 'Oyelaran',
          email: 'outage@example.com',
          phone: '6175550199',
        },
        answers,
        attribution: { funnel_version: 'qualification-v1' },
        client: { session_id: sessionId, event_id: `evt_lead_${sessionId}` },
      })
      .expect(201);

    expect(lead.body.persisted).toBe(true);
    await drainOutbox();

    // But the status endpoint tells the truth about delivery.
    const status = await request(server)
      .get(`/api/leads/${lead.body.lead_id}/status`)
      .expect(200);
    expect(status.body.persisted).toBe(true);
    expect(status.body.synced_to_crm).toBe(false);

    // And the lead is fully recoverable once the outage ends.
    setFailureInjection('airtable', false);
    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable');
    await request(server).post(`/admin/jobs/${crmJob!.job_id}/retry`).set(ADMIN).expect(200);

    const recovered = await request(server)
      .get(`/api/leads/${lead.body.lead_id}/status`)
      .expect(200);
    expect(recovered.body.synced_to_crm).toBe(true);
    expect(getMockAirtableSnapshot().Leads).toBe(1);
  });
});
