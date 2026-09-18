import { Router } from 'express';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { signPayload, safeCompare } from '../lib/hash.js';
import { logger } from '../lib/logger.js';
import {
  executeLeadToAirtableWorkflow,
  leadPayloadSchema,
  SUPPORTED_SCHEMA_VERSION,
} from '../services/n8n/workflow.js';

export const mockN8nRouter = Router();

/**
 * A faithful local stand-in for the n8n webhook.
 *
 * It implements exactly the node chain exported in
 * `n8n/lead-to-airtable.workflow.json`:
 *
 *   Webhook -> Verify signature -> Validate payload -> Check idempotency
 *           -> Transform -> Upsert Airtable -> Log execution -> Respond
 *
 * Why build it? Because an interviewer cannot be asked to stand up an n8n
 * instance to see the system work, and because a workflow you cannot test is a
 * workflow you cannot trust.
 *
 * Point N8N_WEBHOOK_URL at a real n8n instance and this route is simply unused.
 */
mockN8nRouter.post(
  '/webhook/lead-to-airtable',
  asyncHandler(async (req, res) => {
    // --- Node 1: verify the shared-secret signature -------------------------
    // n8n webhooks are unauthenticated by default, which is a common
    // production hole. The workflow rejects anything unsigned.
    const signature = req.header('x-funnel-signature');
    if (env.N8N_WEBHOOK_SECRET) {
      const expected = signPayload(JSON.stringify(req.body), env.N8N_WEBHOOK_SECRET);
      if (!signature || !safeCompare(signature, expected)) {
        logger.warn('n8n_mock.invalid_signature', { request_id: req.requestId });
        return res.status(401).json({ ok: false, message: 'Invalid signature' });
      }
    }

    // --- Node 2: validate the payload ---------------------------------------
    const parsed = leadPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      // 400 is deliberate: a malformed payload is NOT retryable, and the outbox
      // reads the status to decide between retrying and dead-lettering.
      logger.warn('n8n_mock.invalid_payload', {
        request_id: req.requestId,
        fields: Object.keys(parsed.error.flatten().fieldErrors),
      });
      return res.status(400).json({ ok: false, message: 'Payload failed validation' });
    }

    if (parsed.data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      logger.error('n8n_mock.schema_version_mismatch', {
        received: parsed.data.schema_version,
        supported: SUPPORTED_SCHEMA_VERSION,
      });
      return res.status(400).json({ ok: false, message: 'Unsupported schema_version' });
    }

    // --- Nodes 3-7: idempotency, transform, upsert, log ---------------------
    const result = await executeLeadToAirtableWorkflow(parsed.data);
    return res.status(200).json(result);
  }),
);
