/**
 * Vercel serverless entry point.
 *
 * Serverless functions cannot run the long-lived setInterval outbox worker from
 * apps/api/src/index.ts, so instead each request drains due outbox jobs after
 * its response has been sent. waitUntil keeps the function alive for that work
 * without delaying the response the user is waiting on.
 */
import { waitUntil } from '@vercel/functions';
import { createApp } from '../apps/api/dist/app.js';
import { logger } from '../apps/api/dist/lib/logger.js';
import { drainOutbox } from '../apps/api/dist/services/outbox/worker.js';

const app = createApp();

export default function handler(req, res) {
  waitUntil(
    new Promise((resolve) => res.on('finish', resolve))
      .then(() => drainOutbox())
      .catch((error) => logger.error('outbox.drain_failed', { error })),
  );
  return app(req, res);
}
