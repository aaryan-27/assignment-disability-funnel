import { Router } from 'express';
import { emailCaptureSchema, leadSubmissionSchema, type FunnelAnswers } from '@funnel/shared';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { captureEmail, createLead } from '../services/leadService.js';
import { findLeadById, listJobs } from '../store/repository.js';

export const leadsRouter = Router();

/**
 * POST /api/leads - the primary conversion endpoint.
 *
 * Returns 201 with `persisted: true` once the lead is durably committed here.
 * It deliberately does NOT wait for Meta or Airtable: those are outbox jobs.
 * The response tells the client exactly what is true so the UI never overclaims.
 */
leadsRouter.post(
  '/leads',
  rateLimit({ max: env.RATE_LIMIT_MAX_LEADS, name: 'leads' }),
  asyncHandler(async (req, res) => {
    // Accept the idempotency key from the standard header as well as the body.
    const headerKey = req.header('idempotency-key');
    const body = {
      ...req.body,
      idempotency_key: req.body?.idempotency_key ?? headerKey ?? undefined,
    };

    const submission = leadSubmissionSchema.parse(body);

    const result = await createLead(submission, {
      clientIp: req.clientIp,
      userAgent: req.header('user-agent') ?? submission.client.user_agent,
    });

    res.status(result.replayed ? 200 : 201).json({
      ok: true,
      ...result,
      request_id: req.requestId,
    });
  }),
);

/**
 * POST /api/leads/email - partial capture at the email step.
 * Separate endpoint and separate rate-limit bucket: it fires earlier and more
 * often than the full submission.
 */
leadsRouter.post(
  '/leads/email',
  rateLimit({ max: env.RATE_LIMIT_MAX_LEADS * 2, name: 'email_capture' }),
  asyncHandler(async (req, res) => {
    const input = emailCaptureSchema.parse(req.body);

    const result = await captureEmail(
      {
        email: input.email,
        answers: input.answers as FunnelAnswers,
        attribution: input.attribution,
        client: input.client,
      },
      {
        clientIp: req.clientIp,
        userAgent: req.header('user-agent') ?? input.client.user_agent,
      },
    );

    res.status(202).json({ ok: true, ...result, request_id: req.requestId });
  }),
);

/**
 * GET /api/leads/:id/status - lets the success screen tell the truth.
 *
 * The UI polls this once or twice after submitting so it can distinguish
 * "saved and synced" from "saved, sync still in flight" from "saved, sync
 * failed and an operator has been alerted".
 */
leadsRouter.get(
  '/leads/:id/status',
  asyncHandler(async (req, res) => {
    const leadId = req.params.id;
    if (!leadId) throw badRequest('Lead id is required');

    const lead = await findLeadById(leadId);
    if (!lead) throw notFound(`Lead ${leadId} not found`);

    const jobs = (await listJobs(500)).filter((job) => job.lead_id === leadId);

    // Only expose what the browser legitimately needs. No PII, no answers, no
    // qualification reason codes.
    res.json({
      ok: true,
      lead_id: lead.lead_id,
      persisted: true,
      synced_to_crm: lead.synced_to_crm,
      automation: jobs.map((job) => ({
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        next_attempt_at: job.status === 'failed' ? job.next_attempt_at : undefined,
      })),
      request_id: req.requestId,
    });
  }),
);
