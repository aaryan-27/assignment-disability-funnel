/**
 * Vercel serverless entry point.
 *
 * Serverless functions cannot run the long-lived setInterval outbox worker from
 * apps/api/src/index.ts, so instead each request drains due outbox jobs after
 * its response has been sent. waitUntil keeps the function alive for that work
 * without delaying the response the user is waiting on. Retries that come due
 * while the site is quiet are picked up by the Vercel Cron job in vercel.json.
 */
import { waitUntil } from '@vercel/functions';
import { createApp } from '../apps/api/dist/app.js';
import { describeIntegrations, logConfigWarnings } from '../apps/api/dist/config/env.js';
import { logger } from '../apps/api/dist/lib/logger.js';
import { drainOutbox } from '../apps/api/dist/services/outbox/worker.js';

const app = createApp();

// Once per cold start: what is live, and anything unsafe for real traffic.
logger.info('function.cold_start', { integrations: describeIntegrations() });
logConfigWarnings((msg, meta) => logger.warn(msg, meta));

export default function handler(req, res) {
  waitUntil(
    new Promise((resolve) => res.on('finish', resolve))
      .then(() => drainOutbox())
      .catch((error) => logger.error('outbox.drain_failed', { error })),
  );
  return app(req, res);
}
