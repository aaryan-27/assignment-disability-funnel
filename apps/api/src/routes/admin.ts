import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { getMetrics } from '../services/metricsService.js';
import { setFailureInjection, setFailureRate } from '../services/mockControl.js';
import { drainOutbox } from '../services/outbox/worker.js';
import {
  findJob,
  listAutomationRuns,
  listEvents,
  listJobs,
  listLeads,
  requeueJob,
} from '../store/repository.js';

export const adminRouter = Router();

adminRouter.use(adminAuth);

/** GET /admin/metrics - the single call that powers the ops dashboard. */
adminRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const metrics = await getMetrics();
    res.json({ ok: true, ...metrics, request_id: req.requestId });
  }),
);

/**
 * GET /admin/leads - recent leads.
 * Returns only what an operator needs to triage; the email is partially masked
 * because an ops dashboard does not need to display full contact details to
 * answer "did this lead sync?".
 */
adminRouter.get(
  '/leads',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const leads = await listLeads(limit);

    res.json({
      ok: true,
      leads: leads.map((lead) => ({
        lead_id: lead.lead_id,
        created_at: lead.created_at,
        name: `${lead.first_name} ${lead.last_name.slice(0, 1)}.`,
        email_masked: maskEmail(lead.email),
        lead_status: lead.lead_status,
        qualification_outcome: lead.qualification_outcome,
        qualification_score: lead.qualification_score,
        synced_to_crm: lead.synced_to_crm,
        utm_source: lead.attribution.utm_source,
        utm_campaign: lead.attribution.utm_campaign,
        conversion_event_id: lead.conversion_event_id,
      })),
      request_id: req.requestId,
    });
  }),
);

adminRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json({ ok: true, events: await listEvents(limit), request_id: req.requestId });
  }),
);

adminRouter.get(
  '/automation-runs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json({ ok: true, runs: await listAutomationRuns(limit), request_id: req.requestId });
  }),
);

/** GET /admin/jobs - the outbox itself, including the dead-letter queue. */
adminRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const jobs = await listJobs(limit);

    res.json({
      ok: true,
      jobs: (status ? jobs.filter((job) => job.status === status) : jobs).map((job) => ({
        job_id: job.job_id,
        type: job.type,
        workflow: job.workflow,
        status: job.status,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        lead_id: job.lead_id,
        event_id: job.event_id,
        dedupe_key: job.dedupe_key,
        last_error: job.last_error,
        next_attempt_at: job.next_attempt_at,
        created_at: job.created_at,
        updated_at: job.updated_at,
      })),
      request_id: req.requestId,
    });
  }),
);

/**
 * POST /admin/jobs/:id/retry - manual recovery.
 *
 * This is the "no silent failures" promise made operational: an operator can
 * see a dead-lettered lead and replay it. Because the job carries the original
 * dedupe key and the downstream is idempotent, replaying a job that actually
 * did succeed is safe - it updates rather than duplicating.
 */
adminRouter.post(
  '/jobs/:id/retry',
  asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    if (!jobId) throw badRequest('Job id is required');

    const job = await findJob(jobId);
    if (!job) throw notFound(`Job ${jobId} not found`);
    if (job.status === 'succeeded') {
      throw badRequest('Job already succeeded; nothing to retry');
    }

    await requeueJob(job.job_id);
    logger.warn('admin.job_requeued', { job_id: job.job_id, type: job.type });

    // Drain immediately so the operator gets feedback in the same request
    // rather than waiting for the next poll tick.
    const processed = await drainOutbox(5);

    res.json({
      ok: true,
      job_id: job.job_id,
      processed,
      request_id: req.requestId,
    });
  }),
);

/** POST /admin/outbox/drain - force a worker tick. Useful in demos and tests. */
adminRouter.post(
  '/outbox/drain',
  asyncHandler(async (req, res) => {
    const processed = await drainOutbox(50);
    res.json({ ok: true, processed, request_id: req.requestId });
  }),
);

const failureSchema = z.object({
  integration: z.enum(['airtable', 'n8n', 'meta']).optional(),
  enabled: z.boolean().optional(),
  failure_rate: z.number().min(0).max(1).optional(),
});

/**
 * POST /admin/failure-injection - break a downstream on purpose, at runtime.
 * Lets the reliability story be demonstrated live without restarting anything.
 */
adminRouter.post(
  '/failure-injection',
  asyncHandler(async (req, res) => {
    const input = failureSchema.parse(req.body);

    if (input.integration && input.enabled !== undefined) {
      setFailureInjection(input.integration, input.enabled);
    }
    if (input.failure_rate !== undefined) {
      setFailureRate(input.failure_rate);
    }

    const metrics = await getMetrics();
    res.json({
      ok: true,
      failure_injection: metrics.failure_injection,
      request_id: req.requestId,
    });
  }),
);

/** Masks the local part so the dashboard is useful without exposing contacts. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `**@${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}
