import { Router } from 'express';
import { describeIntegrations, env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { snapshot } from '../store/repository.js';

export const healthRouter = Router();

/** Liveness. Intentionally trivial and dependency-free. */
healthRouter.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', uptime_seconds: Math.round(process.uptime()) });
});

/**
 * Readiness, with a health signal the load balancer can act on.
 *
 * A growing dead-letter queue means leads are being captured but not delivered.
 * That is degraded, not dead - so we report it rather than failing the check
 * and taking the funnel offline, which would turn a delivery problem into a
 * revenue problem.
 */
healthRouter.get(
  '/ready',
  asyncHandler(async (req, res) => {
    const stats = await snapshot((db) => ({
      leads: db.leads.length,
      pending_jobs: db.outbox.filter((job) => job.status === 'pending' || job.status === 'failed')
        .length,
      dead_letter: db.outbox.filter((job) => job.status === 'dead_letter').length,
    }));

    const degraded = stats.dead_letter > 0;

    res.status(200).json({
      ok: true,
      status: degraded ? 'degraded' : 'healthy',
      version: env.FUNNEL_VERSION,
      integrations: describeIntegrations(),
      ...stats,
      request_id: req.requestId,
    });
  }),
);

/** Exposes the funnel config so the browser and API can never drift apart. */
healthRouter.get('/config', (_req, res) => {
  res.json({ ok: true, funnel_version: env.FUNNEL_VERSION });
});
