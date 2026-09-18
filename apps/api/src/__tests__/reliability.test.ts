import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { resetStore, snapshot, listJobs, updateJob, STALE_CLAIM_MS } from '../store/repository.js';
import { resetMockAirtable } from '../services/airtable/client.js';
import { setFailureInjection, setFailureRate } from '../services/mockControl.js';
import { computeBackoffMs, drainOutbox, processJob } from '../services/outbox/worker.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { buildSubmission, listenOnce } from './helpers.js';
import type { OutboxJob } from '../store/types.js';

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
  setFailureInjection('n8n', false);
  setFailureInjection('meta', false);
  setFailureRate(0);
});

/** Make every due job attempt-ready regardless of its backoff schedule. */
async function forceDrain(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const jobs = await listJobs(100);
    const due = jobs.filter((job) => job.status === 'pending' || job.status === 'failed');
    if (due.length === 0) break;
    // Fast-forward the backoff so tests do not sleep.
    for (const job of due) {
      await import('../store/repository.js').then((repo) =>
        repo.updateJob(job.job_id, { next_attempt_at: new Date(0).toISOString() }),
      );
    }
    await drainOutbox(50);
  }
}

describe('outbox: happy path', () => {
  it('delivers both side effects and marks the lead synced', async () => {
    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const jobs = await listJobs(10);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job.status).toBe('succeeded');

    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === created.body.lead_id),
    );
    expect(lead?.synced_to_crm).toBe(true);
  });

  it('records an automation run per job with timing', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const runs = await snapshot((db) => db.automation_runs);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.status).toBe('succeeded');
      expect(run.duration_ms).toBeGreaterThanOrEqual(0);
      expect(run.error).toBeUndefined();
    }
  });
});

describe('outbox: failure handling', () => {
  it('never loses the lead when the CRM is down', async () => {
    setFailureInjection('airtable', true);

    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    // The API still reports success, because the lead IS durably saved.
    expect(created.body.persisted).toBe(true);
    expect(created.status).toBe(201);

    await drainOutbox();

    // The lead survived; only the delivery failed.
    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === created.body.lead_id),
    );
    expect(lead).toBeDefined();
    expect(lead?.synced_to_crm).toBe(false);
  });

  it('marks the job failed with an error and a future retry time', async () => {
    setFailureInjection('airtable', true);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const jobs = await listJobs(10);
    const crmJob = jobs.find((job) => job.type === 'lead_to_airtable');

    expect(crmJob?.status).toBe('failed');
    expect(crmJob?.last_error).toMatch(/Injected airtable failure/);
    expect(crmJob?.attempts).toBe(1);
    // No silent failure: there is a scheduled next attempt.
    expect(new Date(crmJob!.next_attempt_at).getTime()).toBeGreaterThan(0);
  });

  it('dead-letters only after the retry budget is spent', async () => {
    setFailureInjection('airtable', true);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    await forceDrain(6);

    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable');
    expect(crmJob?.status).toBe('dead_letter');
    // OUTBOX_MAX_ATTEMPTS is 3 in the test environment.
    expect(crmJob?.attempts).toBe(3);
  });

  it('surfaces the failure in the metrics an operator watches', async () => {
    setFailureInjection('airtable', true);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await forceDrain(6);

    const metrics = await request(server).get('/admin/metrics').set(ADMIN).expect(200);

    expect(metrics.body.automation.airtable_writes_failed).toBe(1);
    expect(metrics.body.automation.dead_letter).toBe(1);
    expect(metrics.body.automation.leads_awaiting_crm_sync).toBe(1);
  });

  it('reports degraded readiness rather than failing the health check', async () => {
    setFailureInjection('airtable', true);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await forceDrain(6);

    // Still 200: the funnel must stay online. A delivery problem is not a
    // reason to take the revenue-generating page offline.
    const ready = await request(server).get('/ready').expect(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.dead_letter).toBe(1);
  });

  it('isolates failures: a broken Meta call does not stop the CRM write', async () => {
    setFailureInjection('meta', true);
    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await forceDrain(6);

    const jobs = await listJobs(10);
    expect(jobs.find((job) => job.type === 'meta_capi')?.status).toBe('dead_letter');
    // The CRM job is entirely unaffected.
    expect(jobs.find((job) => job.type === 'lead_to_airtable')?.status).toBe('succeeded');

    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === created.body.lead_id),
    );
    expect(lead?.synced_to_crm).toBe(true);
  });

  it('dead-letters immediately for a non-retryable error', async () => {
    // A job pointing at a lead that does not exist can never succeed, so
    // burning the whole retry budget on it would be waste.
    const job: OutboxJob = {
      job_id: 'job_missinglead0001',
      type: 'lead_to_airtable',
      workflow: 'lead_to_airtable',
      dedupe_key: 'airtable:ld_missing',
      lead_id: 'ld_missing000000',
      payload: {},
      status: 'in_progress',
      attempts: 1,
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      run_id: 'run_missing00000',
    };

    const result = await processJob(job);
    expect(result.status).toBe('dead_letter');
    expect(result.attempts).toBeLessThan(job.max_attempts);
  });
});

describe('outbox: recovery', () => {
  it('recovers a dead-lettered lead once the downstream is healthy again', async () => {
    setFailureInjection('airtable', true);
    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await forceDrain(6);

    const deadJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable');
    expect(deadJob?.status).toBe('dead_letter');

    // The incident is resolved.
    setFailureInjection('airtable', false);

    // An operator clicks Retry in the dashboard.
    await request(server).post(`/admin/jobs/${deadJob!.job_id}/retry`).set(ADMIN).expect(200);

    const recovered = (await listJobs(10)).find((job) => job.job_id === deadJob!.job_id);
    expect(recovered?.status).toBe('succeeded');

    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === created.body.lead_id),
    );
    expect(lead?.synced_to_crm).toBe(true);
  });

  it('does not duplicate the lead when a recovered job is replayed', async () => {
    const created = await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable');

    // Force a replay of a job that already succeeded downstream.
    const { requeueJob } = await import('../store/repository.js');
    await requeueJob(crmJob!.job_id);
    await drainOutbox();

    // Still exactly one lead, and one CRM job.
    expect(await snapshot((db) => db.leads.length)).toBe(1);
    const lead = await snapshot((db) =>
      db.leads.find((item) => item.lead_id === created.body.lead_id),
    );
    expect(lead?.synced_to_crm).toBe(true);
  });

  it('refuses to retry a job that already succeeded', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    await drainOutbox();

    const job = (await listJobs(10))[0];
    await request(server).post(`/admin/jobs/${job!.job_id}/retry`).set(ADMIN).expect(400);
  });

  it('404s when retrying an unknown job', async () => {
    await request(server).post('/admin/jobs/job_nope00000000/retry').set(ADMIN).expect(404);
  });
});

describe('backoff schedule', () => {
  it('grows exponentially and is capped', () => {
    // Deterministic random so the schedule is assertable.
    const full = () => 1;
    expect(computeBackoffMs(1, 1000, 300_000, full)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 300_000, full)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 300_000, full)).toBe(4000);
    expect(computeBackoffMs(4, 1000, 300_000, full)).toBe(8000);
    // Cap holds no matter how many attempts.
    expect(computeBackoffMs(50, 1000, 300_000, full)).toBe(300_000);
  });

  it('applies jitter so retries do not stampede a recovering service', () => {
    // maxMs passed explicitly: the test environment caps backoff at 50ms, which
    // would otherwise dominate the assertion.
    const results = new Set(
      Array.from({ length: 50 }, () => computeBackoffMs(5, 1000, 300_000)),
    );
    expect(results.size).toBeGreaterThan(5);

    for (const value of results) {
      // Equal jitter guarantees a floor of half the exponential delay. A near
      // zero backoff would let a single drain pass burn the whole retry budget
      // before the downstream had any chance to recover.
      expect(value).toBeGreaterThanOrEqual(8000);
      expect(value).toBeLessThanOrEqual(16_000);
    }
  });

  it('never attempts the same job twice in one drain pass', async () => {
    setFailureInjection('airtable', true);
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    // Both jobs are due; the CRM job fails and reschedules with a tiny test
    // backoff that may well elapse before the pass finishes.
    await drainOutbox(50);

    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable');
    expect(crmJob?.attempts).toBe(1);
    expect(crmJob?.status).toBe('failed');
    setFailureInjection('airtable', false);
  });
});

describe('outbox: abandoned claims', () => {
  // On serverless a function can be killed mid-job, leaving it in_progress.
  it('reclaims a job stuck in_progress past the stale window', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable')!;
    const staleSince = new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString();
    await updateJob(crmJob.job_id, { status: 'in_progress', attempts: 1 });
    // updateJob stamps updated_at, so backdate it in a second write.
    await import('../store/store.js').then(({ store }) =>
      store.transaction((db) => {
        const job = db.outbox.find((item) => item.job_id === crmJob.job_id)!;
        job.updated_at = staleSince;
      }),
    );

    await drainOutbox();

    const recovered = (await listJobs(10)).find((job) => job.job_id === crmJob.job_id);
    expect(recovered?.status).toBe('succeeded');
    expect(recovered?.attempts).toBe(2);
  });

  it('leaves a recently claimed job alone', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);
    const crmJob = (await listJobs(10)).find((job) => job.type === 'lead_to_airtable')!;
    await updateJob(crmJob.job_id, { status: 'in_progress', attempts: 1 });

    await drainOutbox();

    const untouched = (await listJobs(10)).find((job) => job.job_id === crmJob.job_id);
    expect(untouched?.status).toBe('in_progress');
    expect(untouched?.attempts).toBe(1);
  });
});

describe('scheduled drain', () => {
  it('drains due jobs when called by the cron', async () => {
    await request(server).post('/api/leads').send(buildSubmission()).expect(201);

    const response = await request(server).get('/api/cron/drain').expect(200);

    expect(response.body.processed).toBeGreaterThan(0);
    const jobs = await listJobs(10);
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
  });
});

describe('failure injection API', () => {
  it('toggles an integration at runtime', async () => {
    const response = await request(server)
      .post('/admin/failure-injection')
      .set(ADMIN)
      .send({ integration: 'airtable', enabled: true })
      .expect(200);

    expect(response.body.failure_injection.airtable).toBe(true);
    setFailureInjection('airtable', false);
  });

  it('is protected by the admin token', async () => {
    await request(server)
      .post('/admin/failure-injection')
      .send({ integration: 'airtable', enabled: true })
      .expect(401);
  });
});
