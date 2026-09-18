import { Router } from 'express';
import { env, isProduction } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { unauthorized } from '../lib/errors.js';
import { safeCompare } from '../lib/hash.js';
import { logger } from '../lib/logger.js';
import { drainOutbox } from '../services/outbox/worker.js';

export const cronRouter = Router();

/**
 * GET /api/cron/drain - scheduled outbox drain.
 *
 * On serverless there is no long-running worker: jobs are drained after each
 * request. That covers first attempts, but a retry whose backoff elapses while
 * the site is quiet would wait for the next visitor. Vercel Cron calls this on
 * a schedule so retries (and anything a killed function left behind) still go
 * out. Vercel authenticates with `Authorization: Bearer <CRON_SECRET>`.
 */
cronRouter.get(
  '/drain',
  asyncHandler(async (req, res) => {
    if (env.CRON_SECRET) {
      const provided = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!provided || !safeCompare(provided, env.CRON_SECRET)) {
        throw unauthorized('Invalid cron secret');
      }
    } else if (isProduction) {
      throw unauthorized('CRON_SECRET is not configured');
    }

    const processed = await drainOutbox(50);
    logger.info('cron.outbox_drained', { processed: processed.length });
    res.json({ ok: true, processed: processed.length, request_id: req.requestId });
  }),
);
