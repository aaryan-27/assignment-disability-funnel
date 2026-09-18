import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { resetStore, snapshot } from '../store/repository.js';
import { resetMockAirtable } from '../services/airtable/client.js';
import { setFailureInjection, setFailureRate } from '../services/mockControl.js';
import { drainOutbox } from '../services/outbox/worker.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { buildSubmission, listenOnce } from './helpers.js';

const app = createApp();
const server = listenOnce(app);

afterAll(() => {
  server.close();
});
const ADMIN = { 'x-admin-token': process.env.ADMIN_API_TOKEN ?? 'test-admin-token' };

beforeEach(async () => {
  await resetStore();
  resetMockAirtable();
  resetRateLimits();
  setFailureInjection('airtable', false);
  setFailureInjection('n8n', false);
  setFailureInjection('meta', false);
  setFailureRate(0);
});

afterEach(async () => {
  await resetStore();
});

describe('POST /api/leads', () => {
  it('accepts a valid submission and returns the ids', async () => {
    const submission = buildSubmission();

    const response = await request(server).post('/api/leads').send(submission).expect(201);

    expect(response.body.ok).toBe(true);
    expect(response.body.lead_id).toMatch(/^ld_/);
    // The server reuses the browser's event_id so Pixel and CAPI can dedupe.
    expect(response.body.event_id).toBe(submission.client.event_id);
    expect(response.body.persisted).toBe(true);
    expect(response.body.qualification_outcome).toBe('qualified');
  });

  it('persists the lead and its answers', async () => {
    const response = await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    const data = await snapshot((db) => ({
      leads: db.leads.length,
      answers: db.qualification.filter((row) => row.lead_id === response.body.lead_id).length,
    }));

    expect(data.leads).toBe(1);
    expect(data.answers).toBe(10);
  });

  it('enqueues both side effects rather than calling them inline', async () => {
    const response = await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    const types = response.body.jobs.map((job: { type: string }) => job.type);
    expect(types).toContain('meta_capi');
    expect(types).toContain('lead_to_airtable');
  });

  it('rejects an invalid phone number with a field-level message', async () => {
    const submission = buildSubmission();
    submission.contact.phone = '123';

    const response = await request(server).post('/api/leads').send(submission).expect(400);

    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.fields['contact.phone']).toMatch(/valid/i);
  });

  it('rejects an invalid email', async () => {
    const submission = buildSubmission();
    submission.contact.email = 'not-an-email';

    const response = await request(server).post('/api/leads').send(submission).expect(400);
    expect(response.body.error.fields['contact.email']).toBeTruthy();
  });

  it('rejects a missing first name', async () => {
    const submission = buildSubmission();
    submission.contact.first_name = '   ';

    const response = await request(server).post('/api/leads').send(submission).expect(400);
    expect(response.body.error.fields['contact.first_name']).toBeTruthy();
  });

  it('strips answers the branching rules make unreachable', async () => {
    const submission = buildSubmission();
    // Crafted payload: claims an attorney while denying a pending application.
    submission.answers.application_pending = 'no';
    submission.answers.attorney_represented = 'yes';
    submission.answers.attorney_firm = 'allsup';

    const response = await request(server).post('/api/leads').send(submission).expect(201);

    const stored = await snapshot((db) =>
      db.qualification
        .filter((row) => row.lead_id === response.body.lead_id)
        .map((row) => row.question_id),
    );

    expect(stored).not.toContain('attorney_represented');
    expect(stored).not.toContain('attorney_firm');
  });

  it('sanitises markup out of names before they reach the CRM', async () => {
    const submission = buildSubmission();
    submission.contact.first_name = '<script>alert(1)</script>Dana';

    const response = await request(server).post('/api/leads').send(submission).expect(201);

    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === response.body.lead_id),
    );
    expect(lead?.first_name).not.toContain('<');
    expect(lead?.first_name).not.toContain('>');
  });

  it('recomputes qualification server-side and ignores a client claim', async () => {
    const submission = buildSubmission();
    // Client says "over_20 hours", which is a hard disqualifier. Any client-side
    // claim to the contrary is irrelevant - the server decides.
    submission.answers.work_hours = 'over_20';

    const response = await request(server).post('/api/leads').send(submission).expect(201);
    expect(response.body.qualification_outcome).toBe('disqualified');
  });

  it('does not report a disqualified lead to Meta, but still stores it', async () => {
    const submission = buildSubmission();
    submission.answers.work_hours = 'over_20';

    const response = await request(server).post('/api/leads').send(submission).expect(201);

    const types = response.body.jobs.map((job: { type: string }) => job.type);
    // CRM still gets it - the business wants every lead.
    expect(types).toContain('lead_to_airtable');
    // Meta does not - we only train the algorithm on good conversions.
    expect(types).not.toContain('meta_capi');
  });

  it('preserves attribution through to the stored lead', async () => {
    const response = await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === response.body.lead_id),
    );

    expect(lead?.attribution.utm_source).toBe('facebook');
    expect(lead?.attribution.utm_campaign).toBe('ssdi_prospecting_q3');
    expect(lead?.attribution.fbclid).toBe('IwAR0TestClickId');
  });

  it('never stores a raw client IP', async () => {
    const response = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === response.body.lead_id),
    );

    expect(lead).toBeDefined();
    expect((lead as unknown as Record<string, unknown>).client_ip).toBeUndefined();
    // Only a hash is retained.
    expect(lead?.client_ip_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('idempotency', () => {
  it('returns the same lead for a replayed submission', async () => {
    const submission = buildSubmission();

    const first = await request(server).post('/api/leads').send(submission).expect(201);
    // Exactly what the browser retry path sends after a timeout.
    const second = await request(server).post('/api/leads').send(submission).expect(200);

    expect(second.body.lead_id).toBe(first.body.lead_id);
    expect(second.body.replayed).toBe(true);

    const leadCount = await snapshot((db) => db.leads.length);
    expect(leadCount).toBe(1);
  });

  it('honours the Idempotency-Key header', async () => {
    const submission = buildSubmission();
    delete (submission as { idempotency_key?: string }).idempotency_key;

    const first = await request(server)
      .post('/api/leads')
      .set('idempotency-key', 'retry-key-123')
      .send(submission)
      .expect(201);

    const second = await request(server)
      .post('/api/leads')
      .set('idempotency-key', 'retry-key-123')
      .send(submission)
      .expect(200);

    expect(second.body.lead_id).toBe(first.body.lead_id);
    expect(await snapshot((db) => db.leads.length)).toBe(1);
  });

  it('counts an idempotent replay as a prevented duplicate', async () => {
    const submission = buildSubmission();

    await request(server).post('/api/leads').send(submission).expect(201);
    await request(server).post('/api/leads').send(submission).expect(200);

    const metrics = await request(server).get('/admin/metrics').set(ADMIN).expect(200);
    expect(metrics.body.automation.duplicates_prevented).toBeGreaterThanOrEqual(1);
  });

  it('does not create duplicate outbox jobs on replay', async () => {
    const submission = buildSubmission();

    await request(server).post('/api/leads').send(submission).expect(201);
    await request(server).post('/api/leads').send(submission).expect(200);

    const jobCount = await snapshot((db) => db.outbox.length);
    // One meta_capi + one lead_to_airtable. Not four.
    expect(jobCount).toBe(2);
  });

  it('survives concurrent duplicate submissions', async () => {
    const submission = buildSubmission();

    // Five simultaneous retries - the classic mobile-network double-tap.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(server).post('/api/leads').send(submission)),
    );

    for (const response of responses) {
      expect([200, 201]).toContain(response.status);
    }

    const leadIds = new Set(responses.map((response) => response.body.lead_id));
    expect(leadIds.size).toBe(1);
    expect(await snapshot((db) => db.leads.length)).toBe(1);
  });

  it('treats a different submission as a new lead', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    expect(await snapshot((db) => db.leads.length)).toBe(2);
  });

  it('flags a repeat email as duplicate and suppresses a second Meta conversion', async () => {
    const first = buildSubmission();
    const second = buildSubmission();
    second.contact.email = first.contact.email;

    await request(server).post('/api/leads').send(first).expect(201);
    const response = await request(server).post('/api/leads').send(second).expect(201);

    expect(response.body.status).toBe('duplicate');
    const types = response.body.jobs.map((job: { type: string }) => job.type);
    expect(types).not.toContain('meta_capi');
  });
});

describe('GET /api/leads/:id/status', () => {
  it('reports persistence and sync state without leaking PII', async () => {
    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const response = await request(server)
      .get(`/api/leads/${created.body.lead_id}/status`)
      .expect(200);

    expect(response.body.persisted).toBe(true);
    expect(response.body.synced_to_crm).toBe(true);
    expect(response.body.automation.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('@example.com');
    expect(serialised).not.toContain('Whitfield');
  });

  it('404s for an unknown lead', async () => {
    await request(server).get('/api/leads/ld_doesnotexist0000/status').expect(404);
  });
});

describe('POST /api/leads/email', () => {
  it('accepts a partial capture', async () => {
    const submission = buildSubmission();

    const response = await request(server)
      .post('/api/leads/email')
      .send({
        email: 'partial@example.com',
        answers: submission.answers,
        attribution: submission.attribution,
        client: { session_id: submission.client.session_id, event_id: 'evt_emailcapture01' },
      })
      .expect(202);

    expect(response.body.duplicate).toBe(false);
  });

  it('ignores a replayed capture rather than double counting', async () => {
    const submission = buildSubmission();
    const body = {
      email: 'partial@example.com',
      answers: submission.answers,
      attribution: submission.attribution,
      client: { session_id: submission.client.session_id, event_id: 'evt_emailcapture02' },
    };

    await request(server).post('/api/leads/email').send(body).expect(202);
    const second = await request(server).post('/api/leads/email').send(body).expect(202);

    expect(second.body.duplicate).toBe(true);
  });
});

describe('rate limiting', () => {
  it('rejects a burst beyond the configured limit', async () => {
    const max = Number(process.env.RATE_LIMIT_MAX_LEADS ?? 10);
    let limited = 0;

    for (let i = 0; i < max + 5; i += 1) {
      const response = await request(server).post('/api/leads').send(buildSubmission());
      if (response.status === 429) limited += 1;
    }

    expect(limited).toBeGreaterThan(0);
  });
});

describe('admin API', () => {
  it('requires a token', async () => {
    await request(server).get('/admin/metrics').expect(401);
    await request(server).get('/admin/metrics').set('x-admin-token', 'wrong').expect(401);
    await request(server).get('/admin/metrics').set(ADMIN).expect(200);
  });

  it('reports funnel and automation metrics', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const response = await request(server).get('/admin/metrics').set(ADMIN).expect(200);

    expect(response.body.funnel.lead_submitted).toBe(1);
    expect(response.body.funnel.qualified).toBe(1);
    expect(response.body.automation.airtable_writes_succeeded).toBe(1);
    expect(response.body.automation.dead_letter).toBe(0);
  });

  it('masks lead contact details in the ops view', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    const response = await request(server).get('/admin/leads').set(ADMIN).expect(200);
    const lead = response.body.leads[0];

    expect(lead.email_masked).toContain('*');
    expect(lead.email_masked).not.toMatch(/^dana\./);
    // The full surname is never rendered in the dashboard.
    expect(lead.name).not.toContain('Whitfield');
  });
});
