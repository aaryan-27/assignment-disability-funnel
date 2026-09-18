import { Router } from 'express';
import { shouldSendToMeta, trackEventSchema } from '@funnel/shared';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { logger } from '../lib/logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { enqueueJob, insertEventIfNew } from '../store/repository.js';
import type { BuildEventInput } from '../services/meta/payload.js';

export const eventsRouter = Router();

/**
 * POST /api/events - funnel telemetry beacon.
 *
 * Every funnel event lands here, including ones we never forward to Meta. That
 * is the point: our own store gets the complete picture (which is what powers
 * step-by-step drop-off analysis) while Meta gets the deliberately thin slice
 * defined by the event taxonomy.
 *
 * The schema physically cannot carry an answer value - only a question id and a
 * step number - so this endpoint cannot become an accidental leak channel.
 */
eventsRouter.post(
  '/events',
  rateLimit({ max: env.RATE_LIMIT_MAX_EVENTS, name: 'events' }),
  asyncHandler(async (req, res) => {
    const input = trackEventSchema.parse(req.body);

    const { duplicate } = await insertEventIfNew({
      event_id: input.event_id,
      lead_id: input.lead_id,
      session_id: input.session_id,
      event_name: input.event_name,
      timestamp: new Date().toISOString(),
      source: 'browser',
      status: 'received',
      pixel_fired: input.pixel_fired ?? false,
      step_number: input.step_number,
      question_id: input.question_id,
    });

    if (duplicate) {
      // A duplicate here is normal - beacons get retried on flaky mobile
      // networks. Counting them is how we prove dedup is working.
      logger.debug('events.duplicate_ignored', { event_id: input.event_id });
      return res.status(200).json({ ok: true, duplicate: true, request_id: req.requestId });
    }

    // Server-side delivery for events whose taxonomy says the server owns them.
    // `both` events are handled by the lead service, which has the PII needed
    // for good match quality; this path covers server-only events.
    const serverOwned = shouldSendToMeta(input.event_name, 'server');
    const browserAlreadySent = input.pixel_fired === true;

    if (serverOwned && !browserAlreadySent) {
      const payload: BuildEventInput & { eventTimeIso: string } = {
        eventName: input.event_name,
        eventId: input.event_id,
        eventTimeIso: new Date().toISOString(),
        fbp: input.attribution?.fbp,
        fbc: input.attribution?.fbc,
        fbclid: input.attribution?.fbclid,
        clientIp: req.clientIp,
        userAgent: req.header('user-agent'),
        sourceUrl: input.attribution?.landing_page,
        stepNumber: input.step_number,
      };

      await enqueueJob({
        type: 'meta_capi',
        dedupe_key: `meta:${input.event_id}`,
        payload: payload as unknown as Record<string, unknown>,
        event_id: input.event_id,
        lead_id: input.lead_id,
        workflow: `meta_capi_${input.event_name}`,
      });
    }

    return res.status(202).json({ ok: true, duplicate: false, request_id: req.requestId });
  }),
);
